import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { branchProblem, worktreeDestination } from "@noren/model";
import type { Backend, BranchProblem, Worktree } from "@noren/model";
import { ConfirmDialog } from "./ConfirmDialog";
import { useT } from "./i18n";

type WorktreeBackend = Pick<Backend, "listWorktrees" | "createWorktree" | "removeWorktree">;

/** The sentence of a rejection: the bridge rejects with a string, the fake backend with an Error. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PROBLEM_KEYS = {
  empty: "worktree.problem.empty",
  dash: "worktree.problem.dash",
  control: "worktree.problem.control",
} as const satisfies Record<BranchProblem, string>;

/** What the dialogs learn about the repository: its worktrees, or why it cannot be used. */
type Repository =
  | { status: "loading" }
  | { status: "ready"; worktrees: Worktree[] }
  | { status: "failed"; reason: string };

/** Reads the worktrees of the repository `cwd` is in, once, when the dialog opens. */
function useRepository(backend: WorktreeBackend, cwd: string): [Repository, () => void] {
  const [repository, setRepository] = useState<Repository>({ status: "loading" });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let alive = true;
    backend.listWorktrees(cwd).then(
      (worktrees) => {
        if (alive) setRepository({ status: "ready", worktrees });
      },
      (error: unknown) => {
        if (alive) setRepository({ status: "failed", reason: reasonOf(error) });
      },
    );
    return () => {
      alive = false;
    };
  }, [backend, cwd, round]);
  return [repository, () => setRound((n) => n + 1)];
}

interface NewWorktreeDialogProps {
  backend: WorktreeBackend;
  /** The folder of the pane in use: the repository is the one it is in. */
  cwd: string;
  /** The worktree was made; the caller opens a tab in it. */
  onCreated(worktree: Worktree): void;
  onClose(): void;
}

/** Asks for the branch of a new worktree and makes it next to the repository. */
export function NewWorktreeDialog({ backend, cwd, onCreated, onClose }: NewWorktreeDialogProps) {
  const t = useT();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [repository] = useRepository(backend, cwd);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const name = branch.trim();
  const problem = branchProblem(name);
  const main = repository.status === "ready" ? repository.worktrees[0] : undefined;
  const destination =
    main !== undefined && problem === undefined ? worktreeDestination(main.path, name) : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || repository.status !== "ready") return;
    if (problem !== undefined) {
      setError(t(PROBLEM_KEYS[problem]));
      return;
    }
    setBusy(true);
    setError(undefined);
    backend.createWorktree(cwd, name).then(
      (worktree) => onCreated(worktree),
      (failure: unknown) => {
        setBusy(false);
        setError(reasonOf(failure));
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="dialog-backdrop">
      <div
        className="space-dialog worktree-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <form className="dialog-form" onSubmit={submit}>
          <h2 id={titleId}>{t("worktree.new.title")}</h2>
          <label className="field">
            <span>{t("worktree.new.branch")}</span>
            <input
              ref={inputRef}
              value={branch}
              placeholder={t("worktree.new.branchHint")}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                setBranch(e.target.value);
                setError(undefined);
              }}
            />
          </label>
          {repository.status === "loading" && (
            <p className="worktree-note" role="status">
              {t("worktree.loading")}
            </p>
          )}
          {destination !== undefined && (
            <p className="worktree-note">{t("worktree.new.folder", { path: destination })}</p>
          )}
          {repository.status === "failed" && <p role="alert">{repository.reason}</p>}
          {error !== undefined && <p role="alert">{error}</p>}
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              className="primary"
              disabled={busy || repository.status !== "ready" || problem !== undefined}
            >
              {busy ? t("worktree.new.creating") : t("worktree.new.create")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface RemoveWorktreeDialogProps {
  backend: WorktreeBackend;
  cwd: string;
  /** The worktree was removed. */
  onRemoved(worktree: Worktree): void;
  onClose(): void;
}

/**
 * Lists the worktrees of the repository except the main one, and asks before removing the one the
 * person picks. A refusal of git (changes in the worktree) is shown with its own words; nothing is
 * ever forced.
 */
export function RemoveWorktreeDialog({
  backend,
  cwd,
  onRemoved,
  onClose,
}: RemoveWorktreeDialogProps) {
  const t = useT();
  const titleId = useId();
  const [repository, reload] = useRepository(backend, cwd);
  const [pending, setPending] = useState<Worktree>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const hasList = repository.status === "ready" && repository.worktrees.some((w) => !w.main);

  // The keyboard goes to the first worktree of the list once it is there, and back to it when a
  // refused removal returns to the list.
  useEffect(() => {
    if (hasList && pending === undefined) listRef.current?.querySelector("button")?.focus();
  }, [hasList, pending]);

  if (pending !== undefined) {
    return (
      <ConfirmDialog
        title={t("worktree.remove.confirmTitle")}
        message={t("worktree.remove.confirmMessage", {
          branch: pending.branch ?? t("worktree.remove.detached"),
        })}
        detail={pending.path}
        confirmLabel={t("worktree.remove.confirm")}
        onCancel={() => setPending(undefined)}
        onConfirm={() => {
          if (busy) return;
          setBusy(true);
          backend.removeWorktree(cwd, pending.path).then(
            () => onRemoved(pending),
            (failure: unknown) => {
              // Back to the list with git's reason; the list is read again, as it may have changed.
              setBusy(false);
              setPending(undefined);
              setError(reasonOf(failure));
              reload();
            },
          );
        }}
      />
    );
  }

  const linked = repository.status === "ready" ? repository.worktrees.filter((w) => !w.main) : [];
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="dialog-backdrop">
      <div
        className="space-dialog worktree-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{t("worktree.remove.title")}</h2>
        {repository.status === "loading" && (
          <p className="worktree-note" role="status">
            {t("worktree.loading")}
          </p>
        )}
        {repository.status === "failed" && <p role="alert">{repository.reason}</p>}
        {repository.status === "ready" && linked.length === 0 && (
          <p className="worktree-note">{t("worktree.remove.none")}</p>
        )}
        {linked.length > 0 && (
          <>
            <p className="worktree-note">{t("worktree.remove.pick")}</p>
            <ul ref={listRef} className="worktree-list" aria-label={t("worktree.remove.list")}>
              {linked.map((worktree) => (
                <li key={worktree.path}>
                  <button
                    type="button"
                    onClick={() => {
                      setError(undefined);
                      setPending(worktree);
                    }}
                  >
                    <span className="worktree-branch">
                      {worktree.branch ?? t("worktree.remove.detached")}
                    </span>
                    <span className="worktree-path">{worktree.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {error !== undefined && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
