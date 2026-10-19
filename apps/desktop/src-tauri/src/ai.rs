//! The AI commands of the page: list the providers, hand over the providers of the settings, store
//! or remove a key, list the models of Ollama, test a connection, ask a question and cancel it.
//!
//! The work is in [`AiState`], which needs no Tauri runtime: it holds the vault (a trait, so the
//! tests give it a fake one), the providers, the client of `noren_core::ai` and the requests in
//! flight (id to [`CancellationToken`]). The commands at the bottom only unpack the arguments of
//! the page and hand the events to a `Channel`.
//!
//! The providers are the pre-defined Ollama plus the ones of `ai.providers` in `config.jsonc`,
//! which the page hands over with `ai_configure` whenever the settings load or change; this side
//! checks them again, as it does not take the page's word for them.
//!
//! The key goes from the vault to the header of the request and nowhere else: `ai_providers`
//! says only whether a key exists, `ai_set_key` is the only way in (`ai_configure` takes no key
//! and refuses a provider that comes with one), nothing is ever logged and no error text carries
//! it (the client takes it out of the texts it returns).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use noren_core::{
    AiClient, AiError, CancellationToken, ChatMessage, DEFAULT_TIMEOUT, KeyVault, KeyringVault,
    OllamaProbe, Provider, ProviderKind, Role, StreamEvent, is_http_address, is_valid_provider_id,
};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;

/// The id of the pre-defined Ollama. No provider of the settings may take it.
const OLLAMA_ID: &str = "ollama";

/// The most providers the settings may list (the schema of the settings says the same).
pub const MAX_PROVIDERS: usize = 50;

/// The longest model name accepted, in characters.
const MAX_MODEL_CHARS: usize = 200;

/// A provider as the page sees it. The key is never part of it, only whether one is stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    /// `openai-compatible` or `anthropic`.
    pub kind: String,
    pub base_url: String,
    /// The default model of the provider; empty when none is set yet.
    pub model: String,
    pub has_key: bool,
}

/// A provider of `ai.providers` in the settings, as the page hands it over. There is no key in it
/// and no room for one: a field it does not know makes the whole list be refused.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConfigDto {
    pub id: String,
    /// `openai-compatible` or `anthropic`.
    pub kind: String,
    pub base_url: String,
    /// The default model of the provider.
    pub model: String,
}

/// What `ai_ollama_models` finds: whether Ollama answered, and the models it has installed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModels {
    pub found: bool,
    pub models: Vec<String>,
}

/// How a connection test ended. A failure is an answer, not an error of the command: `kind` is
/// one of the kinds of [`AiStreamEvent::Error`] and `message` is meant to be shown to the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionReport {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl ConnectionReport {
    fn failed(error: &AiError) -> Self {
        ConnectionReport {
            ok: false,
            kind: Some(error_kind(error)),
            message: Some(error.to_string()),
        }
    }
}

/// A message of the question, as the page sends it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ChatMessageDto {
    /// `system`, `user` or `assistant`.
    pub role: String,
    pub content: String,
}

/// What the channel of `ai_chat_stream` delivers: zero or more `delta`, then exactly one `done`
/// or `error`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiStreamEvent {
    Delta {
        text: String,
    },
    Done,
    /// `kind` is one of `invalid-request`, `auth`, `http`, `network`, `timeout`, `cancelled`,
    /// `provider`, `protocol`; `message` is meant to be shown to the user.
    Error {
        kind: &'static str,
        message: String,
    },
}

impl From<StreamEvent> for AiStreamEvent {
    fn from(event: StreamEvent) -> Self {
        match event {
            StreamEvent::Delta(text) => AiStreamEvent::Delta { text },
            StreamEvent::Done => AiStreamEvent::Done,
            StreamEvent::Error(error) => AiStreamEvent::Error {
                kind: error_kind(&error),
                message: error.to_string(),
            },
        }
    }
}

fn error_kind(error: &AiError) -> &'static str {
    match error {
        AiError::InvalidRequest(_) => "invalid-request",
        AiError::Auth { .. } => "auth",
        AiError::Http { .. } => "http",
        AiError::Network(_) => "network",
        AiError::Timeout => "timeout",
        AiError::Cancelled => "cancelled",
        AiError::Provider(_) => "provider",
        AiError::Protocol(_) => "protocol",
    }
}

fn parse_role(role: &str) -> Option<Role> {
    match role {
        "system" => Some(Role::System),
        "user" => Some(Role::User),
        "assistant" => Some(Role::Assistant),
        _ => None,
    }
}

/// The state of the AI commands.
pub struct AiState {
    vault: Arc<dyn KeyVault>,
    /// The providers that are always there (the pre-defined Ollama); the settings cannot replace
    /// them or take their ids.
    builtin: Vec<Provider>,
    /// The providers of `ai.providers`, replaced as a whole by [`AiState::configure`].
    configured: Mutex<Vec<Provider>>,
    client: AiClient,
    requests: Mutex<HashMap<String, CancellationToken>>,
}

/// Takes a request out of the map when it ends, however it ends (also when the future of the
/// command is dropped).
struct InFlight<'a> {
    state: &'a AiState,
    id: String,
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.state.requests().remove(&self.id);
    }
}

impl AiState {
    /// A state whose `builtin` providers are always listed, first. The providers of the settings
    /// come after them once [`AiState::configure`] is called.
    pub fn new(vault: Arc<dyn KeyVault>, builtin: Vec<Provider>, client: AiClient) -> Self {
        AiState {
            vault,
            builtin,
            configured: Mutex::new(Vec::new()),
            client,
            requests: Mutex::new(HashMap::new()),
        }
    }

    /// The state of a normal run: the keychain of the system and the pre-defined Ollama. The
    /// providers of the settings join the list when the page hands them over.
    pub fn system() -> Result<Self, String> {
        Self::with_vault(Arc::new(KeyringVault::new()))
    }

    /// The same with another vault (the smoke runs use one in memory, so they cannot touch the
    /// keychain of the person).
    pub fn with_vault(vault: Arc<dyn KeyVault>) -> Result<Self, String> {
        let client = AiClient::new(DEFAULT_TIMEOUT).map_err(|e| e.to_string())?;
        // Ollama has no default model: the page chooses one from the list Ollama reports.
        Ok(Self::new(vault, vec![Provider::ollama("")], client))
    }

    fn requests(&self) -> std::sync::MutexGuard<'_, HashMap<String, CancellationToken>> {
        self.requests.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn configured(&self) -> std::sync::MutexGuard<'_, Vec<Provider>> {
        self.configured.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The provider with that id, a copy: the list can be replaced while a request uses it.
    fn find(&self, provider_id: &str) -> Option<Provider> {
        self.builtin
            .iter()
            .find(|p| p.id == provider_id)
            .cloned()
            .or_else(|| {
                self.configured()
                    .iter()
                    .find(|p| p.id == provider_id)
                    .cloned()
            })
    }

    /// Every provider, the built-in ones first.
    fn all(&self) -> Vec<Provider> {
        let mut all = self.builtin.clone();
        all.extend(self.configured().iter().cloned());
        all
    }

    /// The providers, each with whether a key is stored. A vault that fails reads as "no key":
    /// the list must still show, and the failure comes up when a key is stored or used.
    pub fn providers(&self) -> Vec<ProviderInfo> {
        self.all()
            .into_iter()
            .map(|p| ProviderInfo {
                has_key: matches!(self.vault.get(&p.id), Ok(Some(_))),
                kind: p.kind.as_str().to_string(),
                id: p.id,
                base_url: p.base_url,
                model: p.model,
            })
            .collect()
    }

    /// Replaces the providers of the settings with `wanted`, in that order, after the built-in
    /// ones. The list is checked again here and taken whole or not at all: on an error the
    /// providers it had stay, and the text says which one is wrong. An id is 1 to 64 letters,
    /// digits, `-` or `_`; it cannot be the id of a built-in provider (`ollama`) or be used twice,
    /// whatever the case (the keychain of Windows does not tell `Foo` from `foo`); the kind is
    /// `openai-compatible` or `anthropic`; the address is `http` or `https` with a host.
    /// A key is never part of this: it stays in the vault under the id of the provider.
    pub fn configure(&self, wanted: &[ProviderConfigDto]) -> Result<(), String> {
        if wanted.len() > MAX_PROVIDERS {
            return Err(format!("there are more than {MAX_PROVIDERS} providers"));
        }
        let mut list: Vec<Provider> = Vec::with_capacity(wanted.len());
        for (index, dto) in wanted.iter().enumerate() {
            let place = format!("provider {}", index + 1);
            let id = dto.id.as_str();
            if !is_valid_provider_id(id) {
                return Err(format!(
                    "{place}: `{id}` is not a provider id (1 to 64 letters, digits, '-' or '_')"
                ));
            }
            let same = |p: &Provider| p.id.eq_ignore_ascii_case(id);
            if self.builtin.iter().any(same) {
                return Err(format!("{place}: the id `{id}` is reserved"));
            }
            if list.iter().any(same) {
                return Err(format!(
                    "{place}: the id `{id}` is used by another provider"
                ));
            }
            let Some(kind) = ProviderKind::parse(&dto.kind) else {
                return Err(format!(
                    "{place}: the kind must be `openai-compatible` or `anthropic`"
                ));
            };
            if !is_http_address(&dto.base_url) {
                return Err(format!(
                    "{place}: the address must start with http:// or https://, name a host and hold no user name or password"
                ));
            }
            let model = dto.model.trim();
            if model.chars().count() > MAX_MODEL_CHARS {
                return Err(format!(
                    "{place}: the model name is longer than {MAX_MODEL_CHARS} characters"
                ));
            }
            list.push(Provider {
                id: id.to_string(),
                kind,
                base_url: dto.base_url.trim().to_string(),
                model: model.to_string(),
            });
        }
        *self.configured() = list;
        Ok(())
    }

    /// Asks the pre-defined Ollama which models it has installed. Ollama not running (or not
    /// being Ollama, or not answering in time) is `found: false`, not an error.
    pub async fn ollama_models(&self) -> OllamaModels {
        let none = OllamaModels {
            found: false,
            models: Vec::new(),
        };
        let Some(ollama) = self.find(OLLAMA_ID) else {
            return none;
        };
        match self.client.detect_ollama(&ollama.base_url).await {
            OllamaProbe::Found(models) => OllamaModels {
                found: true,
                models,
            },
            OllamaProbe::NotFound => none,
        }
    }

    /// Tests the connection to `provider_id` with its key from the vault: the provider has to
    /// answer and accept the key. The outcome is the report; `Err` only when the test could not
    /// even start (a bad id, no such provider, a vault that cannot be read). No text of the
    /// report carries the key.
    pub async fn test_connection(&self, provider_id: &str) -> Result<ConnectionReport, String> {
        if !is_valid_provider_id(provider_id) {
            return Err(format!("`{provider_id}` is not a provider id"));
        }
        let provider = self
            .find(provider_id)
            .ok_or_else(|| format!("there is no provider `{provider_id}`"))?;
        let key = match self.vault.get(provider_id) {
            Ok(key) => key,
            // Ollama needs no key, so a keychain that is not there does not stop it.
            Err(_) if provider.id == OLLAMA_ID => None,
            Err(error) => return Err(error.to_string()),
        };
        Ok(
            match self
                .client
                .check_connection(&provider, key.as_deref())
                .await
            {
                Ok(()) => ConnectionReport {
                    ok: true,
                    kind: None,
                    message: None,
                },
                Err(error) => ConnectionReport::failed(&error),
            },
        )
    }

    /// Stores the key of a provider, or removes it when `key` is empty (blanks around it are
    /// dropped, as a paste brings them). Nothing here prints the key.
    pub fn set_key(&self, provider_id: &str, key: &str) -> Result<(), String> {
        let key = key.trim();
        if key.is_empty() {
            self.vault.delete(provider_id)
        } else {
            self.vault.set(provider_id, key)
        }
        .map_err(|e| e.to_string())
    }

    /// Cancels the request `request_id`. Returns whether there was one; an id that is unknown,
    /// already finished or not shaped like an id does nothing.
    pub fn cancel(&self, request_id: &str) -> bool {
        match self.requests().get(request_id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// How many requests are in flight.
    #[cfg(test)]
    fn in_flight(&self) -> usize {
        self.requests().len()
    }

    /// Asks `provider_id` the question and hands each event to `send`: zero or more `Delta`, then
    /// exactly one `Done` or `Error`. `send` returns `false` when nobody is listening any more
    /// (the page is gone), which cancels the request. `model` replaces the default model of the provider when it
    /// is not empty.
    ///
    /// Returns `Err` when the request could not even start (unknown provider, a bad id, a role
    /// that does not exist, a request id already in use, the vault could not be read); no event
    /// is sent then. Once it started, the outcome is the last event and this returns `Ok`.
    pub async fn chat_stream(
        &self,
        provider_id: &str,
        request_id: &str,
        model: Option<&str>,
        messages: &[ChatMessageDto],
        send: impl FnMut(AiStreamEvent) -> bool + Send,
    ) -> Result<(), String> {
        if !is_valid_provider_id(request_id) {
            return Err("the request id must be 1 to 64 letters, digits, '-' or '_'".to_string());
        }
        if !is_valid_provider_id(provider_id) {
            return Err(format!("`{provider_id}` is not a provider id"));
        }
        let mut provider = self
            .find(provider_id)
            .ok_or_else(|| format!("there is no provider `{provider_id}`"))?;
        if let Some(model) = model.map(str::trim).filter(|m| !m.is_empty()) {
            provider.model = model.to_string();
        }
        let messages = messages
            .iter()
            .map(|m| {
                parse_role(&m.role)
                    .map(|role| ChatMessage {
                        role,
                        content: m.content.clone(),
                    })
                    .ok_or_else(|| format!("`{}` is not a role of a message", m.role))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let key = match self.vault.get(provider_id) {
            Ok(key) => key,
            // Ollama needs no key, so a keychain that is not there does not stop it.
            Err(_) if provider.id == OLLAMA_ID => None,
            Err(error) => return Err(error.to_string()),
        };

        let token = CancellationToken::new();
        {
            let mut requests = self.requests();
            if requests.contains_key(request_id) {
                return Err(format!("the request `{request_id}` is already running"));
            }
            requests.insert(request_id.to_string(), token.clone());
        }
        let _in_flight = InFlight {
            state: self,
            id: request_id.to_string(),
        };

        let mut send = send;
        // The result repeats the last event, which `send` already got.
        let _ = self
            .client
            .chat_stream(&provider, key.as_deref(), &messages, &token, |event| {
                if !send(event.into()) {
                    token.cancel();
                }
            })
            .await;
        Ok(())
    }
}

/// The providers of the page, each with `hasKey`.
#[tauri::command]
pub async fn ai_providers(state: State<'_, AiState>) -> Result<Vec<ProviderInfo>, String> {
    Ok(state.providers())
}

/// Takes the providers of `ai.providers` in the settings (no keys), replacing the ones it had;
/// the list is refused whole, with the reason, when any of them is not valid.
#[tauri::command]
pub async fn ai_configure(
    state: State<'_, AiState>,
    providers: Vec<ProviderConfigDto>,
) -> Result<(), String> {
    state.configure(&providers)
}

/// The models Ollama has installed, or `found: false` when it does not answer.
#[tauri::command]
pub async fn ai_ollama_models(state: State<'_, AiState>) -> Result<OllamaModels, String> {
    Ok(state.ollama_models().await)
}

/// Tests the connection to a provider with its key from the keychain.
#[tauri::command(rename_all = "camelCase")]
pub async fn ai_test_connection(
    state: State<'_, AiState>,
    provider_id: String,
) -> Result<ConnectionReport, String> {
    state.test_connection(&provider_id).await
}

/// Stores the key of `provider_id` in the keychain of the system, or removes it when `key` is
/// empty.
#[tauri::command(rename_all = "camelCase")]
pub async fn ai_set_key(
    state: State<'_, AiState>,
    provider_id: String,
    key: String,
) -> Result<(), String> {
    state.set_key(&provider_id, &key)
}

/// Asks the provider and streams the answer to `on_event`. `request_id` is chosen by the page, so
/// it can cancel (`ai_cancel`) before the first event arrives.
#[tauri::command(rename_all = "camelCase")]
pub async fn ai_chat_stream(
    state: State<'_, AiState>,
    provider_id: String,
    request_id: String,
    model: Option<String>,
    messages: Vec<ChatMessageDto>,
    on_event: Channel<AiStreamEvent>,
) -> Result<(), String> {
    state
        .chat_stream(
            &provider_id,
            &request_id,
            model.as_deref(),
            &messages,
            // A failed send means the page is gone: stop asking the provider.
            |event| on_event.send(event).is_ok(),
        )
        .await
}

/// Cancels the request `request_id`; does nothing for an id that is not running.
#[tauri::command(rename_all = "camelCase")]
pub async fn ai_cancel(state: State<'_, AiState>, request_id: String) -> Result<bool, String> {
    Ok(state.cancel(&request_id))
}

#[cfg(test)]
mod tests;
