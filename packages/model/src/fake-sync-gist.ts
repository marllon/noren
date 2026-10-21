import { sha256Hex } from "./sha256";
import {
  SYNC_LIMITS,
  gistFileName,
  isSyncGistId,
  isSyncablePath,
  pathOfGistFile,
  syncGistTokenProblem,
} from "./sync";
import type { SyncGistStatus, SyncPullResult, SyncPushResult } from "./sync";
import { encodeUtf8 } from "./utf8";

// The sync through a gist (NOR-F19-02a) for the fake backend: GitHub in memory (gists by id, each
// with its files by their flat name), the token in the "keychain" of the fake, and the record this
// computer keeps (the gist and the sha256 of each file as last synced). It follows
// `noren-core::sync_gist` step by step, with the same sentences, and works over the files of the
// config folder of the fake (`localFiles`, shared with the sync through git). Nothing here runs
// git, touches a network or holds a token anywhere a test can read it back.

/** The numbers and names of a hexadecimal-looking id the fake gives the gists it makes. */
const ID_PREFIX = "a1b2c3d4e5f6a7b8c9d";

interface FakeGistData {
  public: boolean;
  /** The files by their flat name, as the page of the gist shows them. */
  files: Map<string, string>;
}

interface GistRecord {
  gistId: string;
  public: boolean;
  /** Path to the sha256 of the file as the gist held it when this computer last synced. */
  files: Map<string, string>;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hashes(files: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...files].map(([path, text]) => [path, sha256Hex(text)]));
}

/** The paths where `known` and `now` differ (a path in only one of them included), in order. */
function differing(known: ReadonlyMap<string, string>, now: ReadonlyMap<string, string>): string[] {
  const paths = new Set([...known.keys(), ...now.keys()]);
  return [...paths].filter((path) => known.get(path) !== now.get(path)).sort(byText);
}

export class FakeGistSync {
  readonly #local: Map<string, string>;
  #token: string | undefined;
  readonly #gists = new Map<string, FakeGistData>();
  #made = 0;
  #record: GistRecord | undefined;

  /** `localFiles`: the files of the config folder of this computer (path to text), kept by the caller. */
  constructor(localFiles: Map<string, string>) {
    this.#local = localFiles;
  }

  status(): SyncGistStatus {
    const hasToken = this.#token !== undefined;
    const record = this.#record;
    if (record === undefined) {
      return { connected: false, gistId: null, public: false, hasToken, pending: [] };
    }
    const pending: SyncGistStatus["pending"] = [];
    for (const [path, text] of [...this.#localFiles()].sort(([a], [b]) => byText(a, b))) {
      const known = record.files.get(path);
      if (known === sha256Hex(text)) continue;
      pending.push({ path, change: known === undefined ? "added" : "modified" });
    }
    return { connected: true, gistId: record.gistId, public: record.public, hasToken, pending };
  }

  setToken(token: string): void {
    const problem = syncGistTokenProblem(token);
    if (problem !== undefined) throw new Error(`this is not a usable token: ${problem}`);
    this.#token = token.trim();
  }

  clearToken(): void {
    this.#token = undefined;
  }

  connect(gistId: string | undefined): SyncGistStatus {
    this.#requireToken();
    if (gistId === undefined) {
      this.#record = this.#create();
    } else {
      const id = gistId.trim();
      if (!isSyncGistId(id)) {
        throw new Error(
          "this is not the id of a gist: use the letters and digits after the last / of its address",
        );
      }
      const gist = this.#read(id);
      const known = this.#record?.gistId === id ? this.#record.files : new Map<string, string>();
      this.#record = { gistId: id, public: gist.public, files: new Map(known) };
    }
    return this.status();
  }

  push(): SyncPushResult {
    const record = this.#requireRecord();
    this.#requireToken();
    const remote = this.#read(record.gistId);
    const moved = differing(record.files, hashes(remote.files));
    if (moved.length > 0) {
      const shown = moved.slice(0, 5).join(", ");
      const more = moved.length > 5 ? ` and ${moved.length - 5} more` : "";
      throw new Error(
        `the gist has changes this computer does not have: pull first, then push again (${shown}${more})`,
      );
    }
    const mine = this.#localFiles();
    const changed = [...mine.keys()]
      .filter((path) => record.files.get(path) !== sha256Hex(mine.get(path) ?? ""))
      .sort(byText);
    if (changed.length === 0) return { committed: false, pushed: false, files: [] };
    const gist = this.#gistOf(record.gistId);
    for (const path of changed) {
      const name = gistFileName(path);
      const text = mine.get(path);
      if (name === undefined || text === undefined) continue;
      gist.files.set(name, text);
      record.files.set(path, sha256Hex(text));
    }
    record.public = gist.public;
    return { committed: true, pushed: true, files: changed };
  }

  pull(): SyncPullResult {
    const record = this.#requireRecord();
    this.#requireToken();
    const remote = this.#read(record.gistId);
    const mine = this.#localFiles();
    const deliver: [string, string][] = [];
    const conflicts: string[] = [];
    for (const path of [...remote.files.keys()].sort(byText)) {
      const text = remote.files.get(path) ?? "";
      const theirs = sha256Hex(text);
      const known = record.files.get(path);
      if (known === theirs) continue;
      const held = mine.get(path);
      if (held === undefined) {
        deliver.push([path, text]);
        continue;
      }
      const heldHash = sha256Hex(held);
      if (heldHash === theirs) continue;
      if (heldHash === known) deliver.push([path, text]);
      else conflicts.push(path);
    }
    if (conflicts.length > 0) return { kind: "conflict", paths: conflicts };
    for (const [path, text] of deliver) this.#local.set(path, text);
    record.files = hashes(remote.files);
    record.public = remote.public;
    return deliver.length === 0
      ? { kind: "up_to_date" }
      : { kind: "updated", files: deliver.map(([path]) => path) };
  }

  // ---- GitHub, for a test to play with ---------------------------------------------------------

  /** A gist on GitHub (another computer's, or one made on its web page), with its files by flat name. */
  put(id: string, gist: { public?: boolean; files?: Readonly<Record<string, string>> }): void {
    this.#gists.set(id, {
      public: gist.public ?? false,
      files: new Map(Object.entries(gist.files ?? {})),
    });
  }

  /** Sets (or, with `undefined`, removes) a file of a gist by its flat name, as an edit on the web page does. */
  setFile(id: string, name: string, text: string | undefined): void {
    const gist = this.#gistOf(id);
    if (text === undefined) gist.files.delete(name);
    else gist.files.set(name, text);
  }

  /** The files of a gist by flat name (a copy). */
  files(id: string): Record<string, string> {
    return Object.fromEntries(this.#gistOf(id).files);
  }

  /** The ids of the gists GitHub holds. */
  ids(): string[] {
    return [...this.#gists.keys()].sort(byText);
  }

  // ---- inside ----------------------------------------------------------------------------------

  #requireRecord(): GistRecord {
    if (this.#record === undefined) {
      throw new Error("no gist is connected yet: connect to one first");
    }
    return this.#record;
  }

  #requireToken(): void {
    if (this.#token === undefined) {
      throw new Error(
        "no GitHub token is stored on this computer: save one first (it needs the gist permission)",
      );
    }
  }

  #gistOf(id: string): FakeGistData {
    const gist = this.#gists.get(id);
    if (gist === undefined) {
      throw new Error(
        "GitHub answered with status 404 (there is no such gist, or the token cannot see it): Not Found",
      );
    }
    return gist;
  }

  /** A gist as the sync reads it: the files of the closed list by path, empty ones left out. */
  #read(id: string): { public: boolean; files: Map<string, string> } {
    const gist = this.#gistOf(id);
    const files = new Map<string, string>();
    for (const [name, text] of gist.files) {
      const path = pathOfGistFile(name);
      if (path === undefined || text === "") continue;
      if (encodeUtf8(text).length > SYNC_LIMITS.fileBytes) {
        throw new Error(
          `${path} is larger than ${SYNC_LIMITS.fileBytes / 1024} KiB and will not be synced`,
        );
      }
      files.set(path, text);
    }
    if (files.size > SYNC_LIMITS.files)
      throw new Error("the gist has more files than a sync carries");
    return { public: gist.public, files };
  }

  /** The files of this computer that may travel (an empty one is left out), by path. */
  #localFiles(): Map<string, string> {
    const files = new Map<string, string>();
    for (const [path, text] of this.#local) {
      if (!isSyncablePath(path) || text === "") continue;
      if (encodeUtf8(text).length > SYNC_LIMITS.fileBytes) {
        throw new Error(
          `${path} is larger than ${SYNC_LIMITS.fileBytes / 1024} KiB and will not be synced`,
        );
      }
      files.set(path, text);
    }
    if (files.size > SYNC_LIMITS.files) {
      throw new Error(`more than ${SYNC_LIMITS.files} files would be synced`);
    }
    return files;
  }

  /** Makes a secret gist from the files of this computer. */
  #create(): GistRecord {
    const mine = this.#localFiles();
    if (mine.size === 0) {
      throw new Error(
        "there is nothing to send yet: a gist cannot be made without a file, and the config folder has none that may travel",
      );
    }
    this.#made += 1;
    const id = `${ID_PREFIX}${this.#made}`;
    const files = new Map<string, string>();
    for (const [path, text] of mine) {
      const name = gistFileName(path);
      if (name !== undefined) files.set(name, text);
    }
    this.#gists.set(id, { public: false, files });
    return { gistId: id, public: false, files: hashes(mine) };
  }
}
