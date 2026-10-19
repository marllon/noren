import { buildCommandMessages, extractCommand } from "@noren/model";
import type { Backend, Config, Space } from "@noren/model";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  applyAskEvent,
  askRequestId,
  askSteps,
  failExchange,
  secretsLine,
  startExchange,
  statusNote,
} from "./ask-panel";
import type { AskExchange } from "./ask-panel";
import { aiProvidersSync } from "./config-store";
import { useT } from "./i18n";
import { useAskTarget } from "./use-ask-target";

// "? text" in the palette: what the person wants, in words, becomes one command for the shell and
// the system of the pane. This dialog shows the exact text that will be sent (the secrets already
// swapped for markers, with their count) and waits for Send; then it shows the command that came
// back and puts it at the prompt when the person asks, never with Enter. The command is one line
// with no line break (`extractCommand`), so it cannot run by itself, and nothing here runs
// anything. The dialog is only mounted where the AI is on.

interface CommandAskDialogProps {
  backend: Pick<Backend, "ai">;
  /** The settings in force: the AI is on in them (the shell checked), and they say who answers Command. */
  config: Config;
  /** The space the request is made in. */
  space: Space;
  /** What the person wants, in their words (the text after the `?`). */
  request: string;
  /** The shell of the pane in use, by name. */
  shell: string;
  /** The system the pane runs on. */
  os: string;
  /** Puts text at the prompt of the terminal in use; false when there was none to put it in. */
  onInsert(text: string): boolean;
  onClose(): void;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CommandAskDialog({
  backend,
  config,
  space,
  request,
  shell,
  os,
  onInsert,
  onClose,
}: CommandAskDialogProps) {
  const t = useT();
  const titleId = useId();
  const { target, looking } = useAskTarget(backend, config, "command");
  const [exchange, setExchange] = useState<AskExchange | undefined>();
  const [note, setNote] = useState("");
  const requestId = useRef<string | undefined>(undefined);
  const insertButton = useRef<HTMLButtonElement>(null);

  const built = useMemo(
    () => buildCommandMessages({ settings: config, space, request, shell, os }),
    [config, space, request, shell, os],
  );
  const streaming = exchange?.status === "streaming";
  const command = useMemo(
    () => (exchange?.status === "done" ? extractCommand(exchange.answer) : undefined),
    [exchange],
  );

  // Closing the dialog ends what is still being answered: nobody is left to read it.
  useEffect(() => {
    const open = requestId;
    return () => {
      if (open.current !== undefined) void backend.ai.cancel(open.current).catch(() => undefined);
    };
  }, [backend]);

  // The command that came back is what the keyboard is for next: Enter puts it at the prompt.
  const hasCommand = command?.ok === true;
  useEffect(() => {
    if (hasCommand) insertButton.current?.focus();
  }, [hasCommand]);

  const send = async () => {
    if (!built.ok || target === undefined || exchange !== undefined) return;
    const id = askRequestId(1, Date.now());
    requestId.current = id;
    const update = (change: (now: AskExchange) => AskExchange) =>
      setExchange((now) => (now === undefined || now.requestId !== id ? now : change(now)));
    setExchange(startExchange(1, id, request, built.redactions));
    try {
      // The provider list the settings made must have reached the backend before it is asked.
      await aiProvidersSync.settled();
      await backend.ai.chat(
        {
          requestId: id,
          providerId: target.providerId,
          model: target.model,
          messages: built.messages,
        },
        (event) => update((now) => applyAskEvent(now, event)),
      );
      update((now) => failExchange(now, t("ask.endedNoResult")));
    } catch (error) {
      update((now) => failExchange(now, reasonOf(error)));
    } finally {
      requestId.current = undefined;
    }
  };

  const stop = () => {
    if (requestId.current !== undefined) {
      void backend.ai.cancel(requestId.current).catch(() => undefined);
    }
  };

  const insert = (text: string) => {
    if (onInsert(text)) onClose();
    else setNote(t("ask.noTerminal"));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  const ended = exchange !== undefined && !streaming;
  const problem = exchange === undefined ? undefined : statusNote(exchange);

  return (
    <div className="dialog-backdrop">
      <div
        className="space-dialog command-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-nr-part="command-dialog"
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{t("commandAsk.title")}</h2>
        <p className="dialog-message">{t("commandAsk.for", { shell, os })}</p>

        {!built.ok ? (
          <>
            <p className="command-problem" role="alert" data-nr-part="command-problem">
              {built.reason === "ai-off"
                ? t("commandAsk.aiOff")
                : built.reason === "empty-request"
                  ? t("commandAsk.empty")
                  : t("commandAsk.tooLong")}
            </p>
            <div className="dialog-actions">
              <button type="button" autoFocus onClick={onClose}>
                {t("common.close")}
              </button>
            </div>
          </>
        ) : target === undefined && !looking ? (
          <>
            <div className="command-steps" data-nr-part="command-steps">
              <p>{t("ask.nothingAnswers")}</p>
              <ol>
                {askSteps("command").map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
            <div className="dialog-actions">
              <button type="button" autoFocus onClick={onClose}>
                {t("common.close")}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="dialog-message">
              {exchange === undefined
                ? t("ask.sendsTo", { target: target?.label ?? t("ask.theProvider") })
                : t("commandAsk.sentTo", { target: target?.label ?? t("ask.theProvider") })}
            </p>
            <div role="region" aria-label={t("ask.review")}>
              <pre
                className="dialog-detail command-preview"
                data-nr-part="command-preview"
                tabIndex={0}
              >
                {built.preview}
              </pre>
            </div>
            <p className="command-secrets" role="status" data-nr-part="command-secrets">
              {secretsLine(built.redactions, built.redactionKinds)}
            </p>

            {streaming && (
              <p className="dialog-message" role="status" data-nr-part="command-waiting">
                {t("commandAsk.waiting")}
              </p>
            )}
            {ended && command?.ok === true && (
              <div className="command-result" data-nr-part="command-result">
                <p className="dialog-message">{t("commandAsk.result")}</p>
                <pre className="dialog-detail" data-nr-part="command-text">
                  {command.command}
                </pre>
                {command.moreLines && <p className="dialog-message">{t("commandAsk.moreLines")}</p>}
                <p className="dialog-message">{t("commandAsk.runsOnEnter")}</p>
              </div>
            )}
            {ended && command?.ok === false && (
              <p className="command-problem" role="alert" data-nr-part="command-problem">
                {command.reason === "too-long"
                  ? t("commandAsk.commandTooLong")
                  : t("commandAsk.noCommand")}
              </p>
            )}
            {ended && command === undefined && problem !== undefined && (
              <p className="command-problem" role="alert" data-nr-part="command-problem">
                {problem}
              </p>
            )}
            {note !== "" && (
              <p className="dialog-message" role="status">
                {note}
              </p>
            )}

            <div className="dialog-actions">
              {exchange === undefined && (
                <>
                  <button type="button" onClick={onClose}>
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    autoFocus
                    disabled={looking}
                    onClick={() => void send()}
                  >
                    {t("ask.send")}
                  </button>
                </>
              )}
              {streaming && (
                <button type="button" onClick={stop}>
                  {t("ask.stop")}
                </button>
              )}
              {ended && (
                <>
                  <button type="button" autoFocus={command?.ok !== true} onClick={onClose}>
                    {t("common.close")}
                  </button>
                  {command?.ok === true && (
                    <button
                      ref={insertButton}
                      type="button"
                      className="primary"
                      data-nr-part="command-insert"
                      onClick={() => insert(command.command)}
                    >
                      {t("commandAsk.insert")}
                    </button>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
