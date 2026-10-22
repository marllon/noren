import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Config, ConfigManager } from "@noren/model";
import { configManager } from "./config-store";
import { profileRowsOf, withSavedIds } from "./settings-profiles";
import { planSave, settledDraft } from "./settings-screen";
import type { PlanContext, SettingsDraft } from "./settings-screen";

// What makes the settings screen write as the person edits (NOR-F20-10c): there is no Save. The draft
// of the screen is only what the file does not have yet (a text on its way, a value with a reason
// under its box); every change that is a value `config.jsonc` takes is written, alone, by
// `ConfigManager.update`, which edits only the settings that differ and keeps the rest of the file
// and its comments. What a person chooses (a switch, a button, a list) is written at once; what is
// typed or dragged waits a moment for the next key, and leaving the box writes it right away.
// Closing the screen writes whatever waits first, so nothing valid is lost.

/** How long a box waits after the last key (or the last move of a slider) before its text is written. */
export const TYPING_WAIT_MS = 500;

/** What the screen draws from the writer: the draft, and why the last write failed. */
export interface WriterState {
  /** What the file does not have yet. */
  readonly draft: SettingsDraft;
  /** Why the last write failed; `undefined` when it went through (or nothing was written). */
  readonly failure: string | undefined;
}

/** What a writer needs of the settings: the state in force and the way to change the file. */
export type WriterManager = Pick<ConfigManager, "state" | "update">;

/**
 * The draft of the settings screen and the writes it makes. Pure: it knows nothing of React (the
 * hook below is the glue) and takes the manager of the file, so a test gives it a fake file.
 */
export class SettingsWriter {
  readonly #manager: WriterManager;
  #context: () => PlanContext;
  #state: WriterState = { draft: {}, failure: undefined };
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** The writes run one after the other, each planned from the file the one before it wrote. */
  #queue: Promise<unknown> = Promise.resolve();
  readonly #listeners = new Set<() => void>();
  /** The profiles the person took away: the only ones a list of rows may take out of the file. */
  readonly #removedProfiles = new Set<string>();

  /**
   * `context` gives what a plan needs and only the screen knows: the ids the shells of the machine
   * take, and the new profile row the person is still in.
   */
  constructor(manager: WriterManager, context: () => PlanContext = () => ({})) {
    this.#manager = manager;
    this.#context = context;
  }

  get state(): WriterState {
    return this.#state;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Where the screen says what a plan needs; it changes with every draw. */
  setContext(context: () => PlanContext): void {
    this.#context = context;
  }

  #set(next: Partial<WriterState>): void {
    this.#state = { ...this.#state, ...next };
    for (const listener of [...this.#listeners]) listener();
  }

  /**
   * Changes the draft. `wait` is how long before the change is written: nothing for a choice, a
   * moment for text on its way (every change starts the wait again, so a text is written once the
   * person pauses).
   */
  edit(update: (now: SettingsDraft) => SettingsDraft, wait = 0): void {
    this.#set({ draft: update(this.#state.draft) });
    this.#later(wait);
  }

  /** Writes what waits. Resolves `false` when something that could be written was not. */
  flush(): Promise<boolean> {
    return this.#run(false);
  }

  /**
   * Writes everything valid that waits, a new profile the person is still filling in included.
   * Resolves `false` when something that could be written was not (the file has a problem, or the
   * write failed); the screen has said why.
   */
  settle(): Promise<boolean> {
    return this.#run(true);
  }

  /** Writes what waits soon (when the person leaves a box). */
  soon(): void {
    this.#later(0);
  }

  /**
   * The person took the profile `id` away. A list of rows that lacks a profile of the file takes it out
   * of the file, so this is how the screen says which absences are the person's own.
   */
  markProfileRemoved(id: string): void {
    this.#removedProfiles.add(id);
  }

  /** Whether a write is waiting for its moment. */
  get waiting(): boolean {
    return this.#timer !== undefined;
  }

  /** The screen is going away: what waits is still written, once. */
  dispose(): void {
    if (this.#timer !== undefined) void this.#run(true);
  }

  #later(wait: number): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#run(false);
    }, wait);
  }

  #run(everything: boolean): Promise<boolean> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const next = this.#queue.then(() => this.#write(everything));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /**
   * The draft with a row for every profile the file has that the list of rows does not, the ones the
   * person took away left out: a profile that came into the file by another program (or by a pull)
   * while the screen was open is not one the list forgot, and a plan must never take it out.
   */
  #withNewProfiles(config: Config, draft: SettingsDraft): SettingsDraft {
    const rows = draft.profiles;
    if (rows === undefined) return draft;
    const known = new Set(rows.filter((row) => row.saved).map((row) => row.key));
    const came = profileRowsOf(config).filter(
      (row) => !known.has(row.key) && !this.#removedProfiles.has(row.key),
    );
    return came.length === 0 ? draft : { ...draft, profiles: [...rows, ...came] };
  }

  async #write(everything: boolean): Promise<boolean> {
    const { config, errors } = this.#manager.state;
    const rebased = this.#withNewProfiles(config, this.#state.draft);
    if (rebased !== this.#state.draft) this.#set({ draft: rebased });
    const wanted = this.#context();
    const plan = planSave(
      config,
      this.#state.draft,
      // On the way out nothing waits any more: the new profile is written whole, and a picture that is
      // still being read goes in (one that could not be read stays out).
      everything
        ? {
            ...wanted,
            heldProfileRows: new Set(),
            ...(wanted.picture === "loading" ? { picture: "ready" as const } : {}),
          }
        : wanted,
    );
    if (plan.changes.length === 0) {
      // Nothing to write: what is left of the draft is only what has a reason under its box (a value
      // put back where the file has it is no draft anymore).
      const left = settledDraft(config, this.#state.draft, wanted);
      const same = JSON.stringify(left) === JSON.stringify(this.#state.draft);
      if (!same || this.#state.failure !== undefined) {
        this.#set({ failure: undefined, ...(same ? {} : { draft: left }) });
      }
      return true;
    }
    // A file with a problem of its own is not edited; the screen says so under its sections.
    if (errors.length > 0) return false;
    const result = await this.#manager.update(plan.changes);
    if (!result.ok) {
      this.#set({ failure: result.message });
      return false;
    }
    for (const id of [...this.#removedProfiles]) {
      if (!(this.#manager.state.config.profiles ?? []).some((profile) => profile.id === id)) {
        this.#removedProfiles.delete(id);
      }
    }
    const rows = this.#state.draft.profiles;
    const written =
      rows === undefined
        ? this.#state.draft
        : { ...this.#state.draft, profiles: withSavedIds(rows, plan.profileIds) };
    this.#set({
      failure: undefined,
      draft: settledDraft(this.#manager.state.config, written, this.#context()),
    });
    return true;
  }
}

/**
 * The writer of a settings screen, for as long as the screen lives. `context` is read when a plan is
 * made, so it can look at the screen as it is then.
 */
export function useSettingsWriter(
  context: () => PlanContext,
): readonly [WriterState, SettingsWriter] {
  const ref = useRef<SettingsWriter>(undefined);
  ref.current ??= new SettingsWriter(configManager, context);
  const writer = ref.current;
  useEffect(() => {
    writer.setContext(context);
  });
  useEffect(
    () => () => {
      writer.dispose();
    },
    [writer],
  );
  const state = useSyncExternalStore(writer.subscribe, () => writer.state);
  return [state, writer];
}
