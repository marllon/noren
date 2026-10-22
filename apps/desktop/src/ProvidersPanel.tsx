import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { AI_PROVIDER_KINDS, OLLAMA_PROVIDER_ID } from "@noren/model";
import type { AiProviderInfo, Backend } from "@noren/model";
import {
  aiProvidersSync,
  configManager,
  useAiProvidersError,
  useConfigState,
} from "./config-store";
import { useT } from "./i18n";
import { NumberBox, SelectBox } from "./SettingsFields";
import {
  NEW_PROVIDER,
  PROVIDER_KIND_LABELS,
  providerSteps,
  connectionLine,
  needsSteps,
  ollamaLine,
  planAddProvider,
  planRemoveProvider,
  reasonWithout,
} from "./settings-providers";
import type { OllamaFound, ProviderDraft } from "./settings-providers";

const KIND_OPTIONS = AI_PROVIDER_KINDS.map((value) => ({
  value,
  label: PROVIDER_KIND_LABELS[value],
}));

/** A line under a provider about what its last button did; a refusal is read out as an alert. */
interface Note {
  text: string;
  alert: boolean;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ProvidersPanelProps {
  backend: Pick<Backend, "ai">;
}

/**
 * The providers of the AI, inside the AI section of the settings screen: Ollama, always listed with
 * the models found on this computer; the providers of `ai.providers` with their key, a connection
 * test and a button to remove them; a form that adds one; and the steps to a first provider while
 * there is none that could answer. Adding and removing act at once (the provider has to be in the
 * file before its key or its connection can be tried), the rest of the screen is saved with Save. A
 * key is typed into a box the page never keeps in its state: it is read when the button is pressed,
 * handed to `ai.setKey` and wiped, so it reaches only the keychain.
 */
export function ProvidersPanel({ backend }: ProvidersPanelProps) {
  const t = useT();
  const { config } = useConfigState();
  const refused = useAiProvidersError();
  const providers = config.ai?.providers ?? [];
  const [ollama, setOllama] = useState<OllamaFound>();
  const [stored, setStored] = useState<readonly AiProviderInfo[]>([]);
  const [keyTick, setKeyTick] = useState(0);
  const [notes, setNotes] = useState<Readonly<Record<string, Note>>>({});
  const [status, setStatus] = useState("");
  const [form, setForm] = useState<ProviderDraft>(NEW_PROVIDER);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const newKeyRef = useRef<HTMLInputElement>(null);
  const keyBoxes = useRef(new Map<string, HTMLInputElement>());

  const say = (id: string, text: string, alert = false) =>
    setNotes((now) => ({ ...now, [id]: { text, alert } }));

  const checkOllama = useCallback(() => {
    setOllama(undefined);
    backend.ai.listOllamaModels().then(setOllama, () => setOllama({ found: false }));
  }, [backend]);

  useEffect(() => {
    checkOllama();
  }, [checkOllama]);

  // Which providers have a key stored, asked again when the list changes or a key is stored or taken
  // out. It waits for the backend to have the list of the file, which is what it answers about.
  const listKey = JSON.stringify(providers);
  useEffect(() => {
    let current = true;
    void aiProvidersSync
      .settled()
      .then(() => backend.ai.providers())
      .then(
        (list) => {
          if (current) setStored(list);
        },
        () => {
          // The keys show as not stored; storing one still works.
        },
      );
    return () => {
      current = false;
    };
  }, [backend, listKey, keyTick]);

  const hasKey = (id: string) => stored.find((provider) => provider.id === id)?.hasKey === true;

  const addPlan = planAddProvider(config, form);
  const problems = tried && !addPlan.ok ? addPlan.problems : {};

  const add = async () => {
    setTried(true);
    setStatus("");
    if (!addPlan.ok || busy) return;
    const { provider } = addPlan;
    setBusy(true);
    const result = await configManager.update(addPlan.edits);
    if (!result.ok) {
      setBusy(false);
      setStatus(result.message);
      return;
    }
    // The key goes to the keychain and nowhere else; the box is wiped whatever happens.
    const box = newKeyRef.current;
    const key = box?.value.trim() ?? "";
    if (box) box.value = "";
    let message = t("providers.added", { id: provider.id });
    if (key !== "") {
      try {
        await backend.ai.setKey(provider.id, key);
        message = t("providers.addedKey", { id: provider.id });
      } catch (error) {
        message = t("providers.addedNoKey", { id: provider.id, reason: reasonWithout(error, key) });
      }
    }
    setForm(NEW_PROVIDER);
    setTried(false);
    setKeyTick((now) => now + 1);
    setStatus(message);
    setBusy(false);
  };

  const remove = async (id: string) => {
    const plan = planRemoveProvider(config, id);
    if (!plan.ok) {
      say(id, plan.reason, true);
      return;
    }
    setBusy(true);
    const result = await configManager.update(plan.edits);
    if (!result.ok) {
      setBusy(false);
      say(id, result.message, true);
      return;
    }
    // A key must not outlive the provider it was for.
    await backend.ai.setKey(id, "").catch(() => undefined);
    setNotes((now) => Object.fromEntries(Object.entries(now).filter(([noted]) => noted !== id)));
    setKeyTick((now) => now + 1);
    setStatus(t("providers.removed", { id }));
    setBusy(false);
  };

  const test = async (id: string) => {
    say(id, t("providers.testing"));
    try {
      await aiProvidersSync.settled();
      const result = await backend.ai.testConnection(id);
      say(id, connectionLine(result), !result.ok);
    } catch (error) {
      say(id, t("providers.testFailed", { reason: reasonOf(error) }), true);
    }
  };

  const saveKey = async (id: string) => {
    const box = keyBoxes.current.get(id);
    const key = box?.value.trim() ?? "";
    if (key === "") {
      say(id, t("providers.pasteFirst"), true);
      return;
    }
    try {
      await backend.ai.setKey(id, key);
      say(id, t("providers.keyStoredNote"));
      setKeyTick((now) => now + 1);
    } catch (error) {
      say(id, t("providers.keyNotStored", { reason: reasonWithout(error, key) }), true);
    } finally {
      if (box) box.value = "";
    }
  };

  const removeKey = async (id: string) => {
    try {
      await backend.ai.setKey(id, "");
      say(id, t("providers.keyRemoved"));
      setKeyTick((now) => now + 1);
    } catch (error) {
      say(id, t("providers.keyNotRemoved", { reason: reasonOf(error) }), true);
    }
  };

  // Enter in a box does what the box is for (the key box stores its key, the form adds the provider).
  const onEnter = (action: () => void) => (event: KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    action();
  };

  const note = (id: string) => {
    const shown = notes[id];
    if (shown === undefined) return null;
    return (
      <p
        role={shown.alert ? "alert" : "status"}
        className={shown.alert ? "settings-warning" : "settings-hint"}
        data-nr-part="settings-ai-provider-note"
      >
        {shown.text}
      </p>
    );
  };

  return (
    <div className="settings-providers" data-nr-part="settings-ai-providers">
      <h4>{t("providers.title")}</h4>
      {needsSteps(config, ollama) && (
        <div className="settings-steps" data-nr-part="settings-ai-steps">
          <p className="settings-hint">{t("providers.noneReady")}</p>
          <ol>
            {providerSteps().map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      )}
      {refused !== undefined && (
        <p role="alert" className="settings-warning" data-nr-part="settings-ai-providers-error">
          {refused}
        </p>
      )}
      <ul className="settings-profiles">
        <li>
          <fieldset
            className="settings-profile"
            aria-label="Ollama"
            data-nr-part="settings-ai-provider"
          >
            <p role="status" className="settings-hint" data-nr-part="settings-ai-ollama">
              {ollamaLine(ollama)}
            </p>
            {ollama?.found === true && ollama.models.length > 0 && (
              <ul className="settings-models" aria-label={t("providers.ollamaModels")}>
                {ollama.models.map((model) => (
                  <li key={model}>{model}</li>
                ))}
              </ul>
            )}
            <button type="button" className="settings-link" onClick={checkOllama}>
              {t("providers.checkAgain")}
            </button>
            <button
              type="button"
              className="settings-link"
              aria-label={t("providers.testOllama")}
              onClick={() => void test(OLLAMA_PROVIDER_ID)}
            >
              {t("providers.test")}
            </button>
            {note(OLLAMA_PROVIDER_ID)}
          </fieldset>
        </li>
        {providers.map((provider) => (
          <li key={provider.id}>
            <fieldset
              className="settings-profile"
              aria-label={provider.id}
              data-nr-part="settings-ai-provider"
              onKeyDown={onEnter(() => void saveKey(provider.id))}
            >
              <p className="settings-hint">
                {t("providers.summary", {
                  kind: PROVIDER_KIND_LABELS[provider.kind],
                  url: provider.baseUrl,
                  model: provider.model,
                })}
              </p>
              <p className="settings-hint" data-nr-part="settings-ai-key-state">
                {hasKey(provider.id) ? t("providers.keyStored") : t("providers.keyNone")}
              </p>
              <label className="settings-option">
                <span>{t("providers.keyLabel", { id: provider.id })}</span>
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  ref={(box) => {
                    if (box) keyBoxes.current.set(provider.id, box);
                    else keyBoxes.current.delete(provider.id);
                  }}
                />
              </label>
              <button
                type="button"
                className="settings-link"
                aria-label={t("providers.storeKeyLabel", { id: provider.id })}
                onClick={() => void saveKey(provider.id)}
              >
                {t("providers.storeKey")}
              </button>
              {hasKey(provider.id) && (
                <button
                  type="button"
                  className="settings-link"
                  aria-label={t("providers.removeKeyLabel", { id: provider.id })}
                  onClick={() => void removeKey(provider.id)}
                >
                  {t("providers.removeKey")}
                </button>
              )}
              <button
                type="button"
                className="settings-link"
                aria-label={t("providers.testLabel", { id: provider.id })}
                onClick={() => void test(provider.id)}
              >
                {t("providers.test")}
              </button>
              <button
                type="button"
                className="settings-link"
                aria-label={t("providers.removeProviderLabel", { id: provider.id })}
                disabled={busy}
                onClick={() => void remove(provider.id)}
              >
                {t("providers.removeProvider")}
              </button>
              {note(provider.id)}
            </fieldset>
          </li>
        ))}
      </ul>
      <fieldset
        className="settings-profile"
        aria-label={t("providers.addGroup")}
        data-nr-part="settings-ai-add"
        onKeyDown={onEnter(() => void add())}
      >
        <NumberBox
          label={t("providers.id")}
          field="ai.providers.item.id"
          value={form.id}
          problem={problems.id}
          text
          wide
          onChange={(id) => setForm((now) => ({ ...now, id }))}
        />
        <SelectBox
          label={t("providers.kind")}
          field="ai.providers.item.kind"
          value={form.kind}
          options={KIND_OPTIONS}
          problem={undefined}
          onChange={(kind) =>
            setForm((now) => ({
              ...now,
              kind: kind === "anthropic" ? "anthropic" : "openai-compatible",
            }))
          }
        />
        <NumberBox
          label={t("providers.address")}
          field="ai.providers.item.baseUrl"
          value={form.baseUrl}
          problem={problems.baseUrl}
          text
          wide
          onChange={(baseUrl) => setForm((now) => ({ ...now, baseUrl }))}
        />
        <NumberBox
          label={t("providers.model")}
          field="ai.providers.item.model"
          value={form.model}
          problem={problems.model}
          text
          wide
          onChange={(model) => setForm((now) => ({ ...now, model }))}
        />
        <div className="settings-number settings-wide">
          <label className="settings-option">
            <span>{t("providers.newKey")}</span>
            <input ref={newKeyRef} type="password" autoComplete="off" spellCheck={false} />
          </label>
        </div>
        {problems.form !== undefined && (
          <span className="settings-hint" role="alert">
            {problems.form}
          </span>
        )}
        <button type="button" className="settings-link" disabled={busy} onClick={() => void add()}>
          {t("providers.add")}
        </button>
      </fieldset>
      <p role="status" className="settings-hint" data-nr-part="settings-ai-providers-status">
        {status}
      </p>
      <p className="settings-hint">{t("providers.footnote")}</p>
    </div>
  );
}
