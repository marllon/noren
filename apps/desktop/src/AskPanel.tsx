import { buildAskMessages } from "@noren/model";
import type { Backend, Config, Id, OllamaModels, Space } from "@noren/model";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  ASK_STEPS,
  NO_CHOICE,
  applyAskEvent,
  askNeedsOllama,
  askRequestId,
  askTarget,
  cutLine,
  failExchange,
  liveChoice,
  readAskChips,
  refusalText,
  secretsLine,
  startExchange,
  statusNote,
  withTab,
} from "./ask-panel";
import type { AskChoice, AskExchange, AskSources } from "./ask-panel";
import { aiProvidersSync } from "./config-store";
import { Markdown } from "./Markdown";

// The Ask panel: a side panel to ask the AI about the shell. The person picks the context with
// chips (the selection, the output of the last command, the screen, other tabs), types a question
// and previews it: the preview is the exact text that will be sent, with the secrets already
// swapped for markers and a count of them. Only then does Send call the provider, and the answer
// arrives in pieces, drawn as Markdown. A code block of the answer has a button that puts its text
// at the prompt of the terminal, never with Enter. Nothing here runs anything, and nothing is sent
// without the preview. The panel is only mounted where the AI is on.

/** A tab the person can add as context. */
export interface AskTabOption {
  id: Id;
  title: string;
}

interface AskPanelProps {
  backend: Pick<Backend, "ai">;
  /** The settings in force: the AI is on in them (the shell checked), and they say who answers Ask. */
  config: Config;
  /** The space the question is asked in. */
  space: Space;
  /** The tabs that can be added with `@`, in the order of the sidebar. */
  tabs: readonly AskTabOption[];
  /** Where the chips are read from, asked when the question is previewed. */
  sources: AskSources;
  /** Puts text at the prompt of the terminal in use; false when there was none to put it in. */
  onInsert(text: string): boolean;
  onClose(): void;
}

/** A question that has been previewed and waits for Send. */
interface Preview {
  built: Extract<ReturnType<typeof buildAskMessages>, { ok: true }>;
  /** The chips that were on and had nothing to read. */
  left: readonly string[];
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AskPanel({
  backend,
  config,
  space,
  tabs,
  sources,
  onInsert,
  onClose,
}: AskPanelProps) {
  const [choice, setChoice] = useState<AskChoice>(NO_CHOICE);
  const [question, setQuestion] = useState("");
  const [preview, setPreview] = useState<Preview | undefined>();
  const [problem, setProblem] = useState("");
  const [exchanges, setExchanges] = useState<AskExchange[]>([]);
  const [inserted, setInserted] = useState("");
  const [tabMenu, setTabMenu] = useState(false);
  const [ollama, setOllama] = useState<OllamaModels | undefined>();
  const panelBox = useRef<HTMLElement>(null);
  const questionBox = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const counter = useRef(0);
  const running = useRef(new Set<string>());

  // A tab closed since it was added leaves the chips by itself.
  const chosen = liveChoice(choice, (id) => tabs.some((tab) => tab.id === id));
  const wantsOllama = askNeedsOllama(config);
  const target = askTarget(config, ollama);
  const looking = target === undefined && wantsOllama && ollama === undefined;
  const busy = exchanges.some((exchange) => exchange.status === "streaming");

  // The question box takes the keyboard when the panel opens (as soon as it can be typed in, which
  // is after the provider is found), and again when the preview closes and when an answer has ended.
  // After the first time it never takes the keyboard from the terminal or from anything outside the
  // panel: only from the page itself or from the panel.
  const previewing = preview !== undefined;
  const focusedOnce = useRef(false);
  useEffect(() => {
    const box = questionBox.current;
    if (looking || previewing || busy || box === null) return;
    const focus = document.activeElement;
    const free = focus === null || focus === document.body || panelBox.current?.contains(focus);
    if (!focusedOnce.current || free === true) {
      box.focus();
      focusedOnce.current = true;
    }
  }, [looking, previewing, busy]);

  // The Ollama of this computer answers when the settings name nobody; its models are asked for here.
  useEffect(() => {
    if (!wantsOllama) return undefined;
    let current = true;
    backend.ai.listOllamaModels().then(
      (found) => {
        if (current) setOllama(found);
      },
      () => {
        if (current) setOllama({ found: false });
      },
    );
    return () => {
      current = false;
    };
  }, [backend, wantsOllama]);

  // Closing the panel ends what is still being answered: nobody is left to read it.
  useEffect(() => {
    const inFlight = running.current;
    return () => {
      for (const requestId of inFlight) void backend.ai.cancel(requestId).catch(() => undefined);
    };
  }, [backend]);

  // The newest words stay in view while the answer grows.
  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [exchanges]);

  const toggle = (chip: "selection" | "lastOutput" | "screen") =>
    setChoice({ ...chosen, [chip]: !chosen[chip] });

  const showPreview = () => {
    const { chips, left } = readAskChips(chosen, sources);
    const built = buildAskMessages({ settings: config, space, question, chips });
    if (!built.ok) {
      setProblem(refusalText(built.reason, config));
      return;
    }
    setProblem("");
    setPreview({ built, left });
  };

  const send = async () => {
    if (preview === undefined || target === undefined || busy) return;
    const { built } = preview;
    counter.current += 1;
    const requestId = askRequestId(counter.current, Date.now());
    const exchange = startExchange(counter.current, requestId, question.trim(), built.redactions);
    const update = (change: (now: AskExchange) => AskExchange) =>
      setExchanges((list) => list.map((one) => (one.requestId === requestId ? change(one) : one)));
    setExchanges((list) => [...list, exchange]);
    setPreview(undefined);
    setQuestion("");
    setInserted("");
    running.current.add(requestId);
    try {
      // The provider list the settings made must have reached the backend before it is asked.
      await aiProvidersSync.settled();
      await backend.ai.chat(
        { requestId, providerId: target.providerId, model: target.model, messages: built.messages },
        (event) => update((now) => applyAskEvent(now, event)),
      );
      update((now) => failExchange(now, "The answer ended without a result."));
    } catch (error) {
      update((now) => failExchange(now, reasonOf(error)));
    } finally {
      running.current.delete(requestId);
    }
  };

  const stop = () => {
    for (const requestId of running.current)
      void backend.ai.cancel(requestId).catch(() => undefined);
  };

  const insert = (text: string) => {
    setInserted(
      onInsert(text)
        ? "Put at the prompt. It runs only when you press Enter in the terminal."
        : "There is no terminal to put it in.",
    );
  };

  const onQuestionKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    showPreview();
  };

  const onPanelKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (tabMenu) setTabMenu(false);
    else if (preview !== undefined) setPreview(undefined);
    else onClose();
  };

  const chipOn = (chip: "selection" | "lastOutput" | "screen") => chosen[chip];
  const chosenTabs = chosen.tabs.flatMap((id) => {
    const tab = tabs.find((option) => option.id === id);
    return tab === undefined ? [] : [tab];
  });

  return (
    <aside
      ref={panelBox}
      className="ask-panel"
      data-nr-part="ask-panel"
      aria-label="Ask"
      onKeyDown={onPanelKey}
    >
      <header className="ask-head">
        <h2>Ask</h2>
        <span className="ask-target" data-nr-part="ask-target">
          {target?.label ?? (looking ? "Looking for a provider..." : "No provider")}
        </span>
        <button type="button" className="ask-close" aria-label="Close Ask" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      <div className="ask-chips" role="group" aria-label="Context">
        {(
          [
            ["selection", "Selection"],
            ["lastOutput", "Last output"],
            ["screen", "Screen"],
          ] as const
        ).map(([chip, label]) => (
          <button
            key={chip}
            type="button"
            className="ask-chip"
            aria-pressed={chipOn(chip)}
            disabled={preview !== undefined || busy}
            onClick={() => toggle(chip)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className="ask-chip"
          aria-expanded={tabMenu}
          aria-controls="ask-tab-list"
          disabled={preview !== undefined || busy}
          onClick={() => setTabMenu((open) => !open)}
        >
          @ Tab
        </button>
        {chosenTabs.map((tab) => (
          <span key={tab.id} className="ask-chip ask-chip-tab" data-nr-part="ask-tab-chip">
            <span>@{tab.title}</span>
            <button
              type="button"
              aria-label={`Remove tab ${tab.title}`}
              disabled={preview !== undefined || busy}
              onClick={() => setChoice(withTab(chosen, tab.id, false))}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      {tabMenu && (
        <div id="ask-tab-list" className="ask-tab-list" role="group" aria-label="Tabs to add">
          {tabs.length === 0 && <p className="ask-hint">There is no other tab.</p>}
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-pressed={chosen.tabs.includes(tab.id)}
              onClick={() => setChoice(withTab(chosen, tab.id, !chosen.tabs.includes(tab.id)))}
            >
              {tab.title}
            </button>
          ))}
        </div>
      )}

      <div className="ask-log" ref={log} role="log" aria-label="Conversation" aria-live="polite">
        {exchanges.length === 0 && (
          <p className="ask-hint" data-nr-part="ask-empty">
            Ask about your shell or your work. The chips above add context from the terminal; you
            see exactly what will be sent before anything goes.
          </p>
        )}
        {exchanges.map((exchange) => {
          const note = statusNote(exchange);
          return (
            <section
              key={exchange.key}
              className="ask-exchange"
              aria-label={`Question: ${exchange.question}`}
              data-nr-part="ask-exchange"
              data-nr-state={exchange.status}
            >
              <p className="ask-question">{exchange.question}</p>
              <div className="ask-answer" data-nr-part="ask-answer">
                <Markdown
                  source={exchange.answer}
                  complete={exchange.status !== "streaming"}
                  onInsert={insert}
                />
                {exchange.status === "streaming" && exchange.answer === "" && (
                  <p className="ask-hint">Waiting for the answer...</p>
                )}
                {note !== undefined && (
                  <p
                    className="ask-status"
                    role={exchange.status === "failed" ? "alert" : "status"}
                    data-nr-part="ask-status"
                  >
                    {note}
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <p className="ask-note" role="status" data-nr-part="ask-note">
        {inserted}
      </p>

      {target === undefined && !looking ? (
        <div className="ask-steps" data-nr-part="ask-steps">
          <p>Nothing can answer yet. To get a first answer:</p>
          <ol>
            {ASK_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ) : preview !== undefined ? (
        <div
          className="ask-review"
          role="region"
          aria-label="Preview of what will be sent"
          data-nr-part="ask-review"
        >
          <p className="ask-hint">
            This goes to {target?.label ?? "the provider"}. Nothing is sent until you press Send.
          </p>
          <pre className="ask-preview" data-nr-part="ask-preview" tabIndex={0}>
            {preview.built.preview}
          </pre>
          <p className="ask-secrets" role="status" data-nr-part="ask-secrets">
            {secretsLine(preview.built.redactions, preview.built.redactionKinds)}
          </p>
          {preview.built.cuts.map((cut) => (
            <p key={cut.index} className="ask-hint">
              {cutLine(cut)}
            </p>
          ))}
          {preview.left.map((line) => (
            <p key={line} className="ask-hint">
              {line}
            </p>
          ))}
          <div className="ask-actions">
            <button type="button" className="ask-primary" autoFocus onClick={() => void send()}>
              Send
            </button>
            <button type="button" onClick={() => setPreview(undefined)}>
              Edit
            </button>
          </div>
        </div>
      ) : (
        <div className="ask-compose">
          <textarea
            ref={questionBox}
            className="ask-question-box"
            aria-label="Question"
            placeholder="Ask a question (Enter to preview, Shift+Enter for a new line)"
            rows={3}
            value={question}
            disabled={busy || looking}
            onChange={(event) => {
              setQuestion(event.target.value);
              setProblem("");
            }}
            onKeyDown={onQuestionKey}
          />
          {problem !== "" && (
            <p className="ask-problem" role="alert" data-nr-part="ask-problem">
              {problem}
            </p>
          )}
          <div className="ask-actions">
            {busy ? (
              <button type="button" className="ask-primary" onClick={stop}>
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="ask-primary"
                disabled={looking}
                onClick={showPreview}
              >
                Preview
              </button>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
