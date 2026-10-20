import { FakeBackend, MAX_GIT_DIFF_BYTES } from "@noren/model";
import type { GitDiff, GitDiffRefusal } from "@noren/model";
import { afterEach, describe, expect, it } from "vitest";
import {
  badFolderNotice,
  contentOf,
  diffLimitNotice,
  diffTitle,
  fileKey,
  fileNote,
  loadDiff,
  noFolderNotice,
  refusalText,
  statusLetter,
  statusText,
} from "./diff-view";
import type { DiffState } from "./diff-view";
import { setLanguage } from "./i18n";

afterEach(() => setLanguage("en"));

const DIFF = [
  "diff --git a/a.txt b/a.txt",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const ready = (diff: GitDiff): DiffState => ({ status: "ready", diff });
const refused = (reason: GitDiffRefusal["reason"], detail?: string): GitDiffRefusal => ({
  kind: "refused",
  reason,
  ...(detail !== undefined ? { detail } : {}),
});

describe("loadDiff", () => {
  it("answers with what the backend read, a refusal included", async () => {
    const backend = new FakeBackend({ gitDiffs: { "/work/repo": DIFF } });
    expect(await loadDiff(backend, "/work/repo")).toEqual({
      status: "ready",
      diff: { kind: "diff", text: DIFF },
    });
    expect(await loadDiff(backend, "/work/none")).toEqual({
      status: "ready",
      diff: { kind: "refused", reason: "not-a-repository" },
    });
  });

  it("turns a failure of the shell into a state instead of throwing", async () => {
    const reader = { readGitDiff: () => Promise.reject(new Error("the shell is gone")) };
    expect(await loadDiff(reader, "/work/repo")).toEqual({
      status: "failed",
      reason: "the shell is gone",
    });
    const odd = { readGitDiff: () => Promise.reject("nope") };
    expect(await loadDiff(odd, "/work/repo")).toEqual({ status: "failed", reason: "nope" });
  });
});

describe("contentOf", () => {
  it("is loading while the read is on its way", () => {
    expect(contentOf({ status: "loading" })).toEqual({ type: "loading" });
  });

  it("reads the files of a diff", () => {
    const content = contentOf(ready({ kind: "diff", text: DIFF }));
    expect(content.type).toBe("files");
    if (content.type === "files") expect(content.files.map(fileKey)).toEqual(["a.txt"]);
  });

  it("says nothing changed for an empty diff and for one that is only blank", () => {
    expect(contentOf(ready({ kind: "diff", text: "" }))).toEqual({ type: "clean" });
    expect(contentOf(ready({ kind: "diff", text: "\n  \n" }))).toEqual({ type: "clean" });
  });

  it("does not draw text that holds no file", () => {
    expect(contentOf(ready({ kind: "diff", text: "warning: something\n" }))).toEqual({
      type: "failed",
      message: "Git printed something that is not a diff this pane can read.",
    });
  });

  it("carries the reason of a refusal, in words", () => {
    expect(contentOf(ready(refused("not-a-repository")))).toEqual({
      type: "refused",
      reason: "not-a-repository",
      message: "This folder is not in a git repository.",
    });
  });

  it("says the shell itself failed when it did", () => {
    expect(contentOf({ status: "failed", reason: "boom" })).toEqual({
      type: "failed",
      message: "The diff could not be read: boom",
    });
  });
});

describe("refusalText", () => {
  const cases: [GitDiffRefusal, string, string][] = [
    [
      refused("relative"),
      "This folder is not a full path on this computer, so git is not run in it.",
      "Esta pasta não é um caminho completo neste computador, então o git não roda nela.",
    ],
    [
      refused("network"),
      "This folder is on the network or is a device, so git is not run in it.",
      "Esta pasta está na rede ou é um dispositivo, então o git não roda nela.",
    ],
    [
      refused("invalid"),
      "The folder is empty, too long or has a control character.",
      "A pasta está vazia, é longa demais ou tem um caractere de controle.",
    ],
    [
      refused("missing"),
      "This folder is not there, or it is not a folder.",
      "Esta pasta não existe, ou não é uma pasta.",
    ],
    [
      refused("not-a-repository"),
      "This folder is not in a git repository.",
      "Esta pasta não está em um repositório git.",
    ],
    [
      refused("git-missing"),
      "Git could not be started. Install git and make sure it is on the PATH.",
      "Não foi possível iniciar o git. Instale o git e confirme que ele está no PATH.",
    ],
    [
      refused("too-large"),
      `The diff is larger than ${MAX_GIT_DIFF_BYTES / 1024 / 1024} MiB, so it is not shown.`,
      `O diff é maior que ${MAX_GIT_DIFF_BYTES / 1024 / 1024} MiB, por isso não é mostrado.`,
    ],
    [
      refused("failed", "fatal: bad object"),
      "Git refused to give the changes: fatal: bad object",
      "O git se recusou a dar as mudanças: fatal: bad object",
    ],
    [
      refused("failed"),
      "Git could not give the changes of this folder.",
      "O git não conseguiu dar as mudanças desta pasta.",
    ],
  ];

  it.each(cases)("says %j in English and in Portuguese", (refusal, english, portuguese) => {
    expect(refusalText(refusal)).toBe(english);
    setLanguage("pt-BR");
    expect(refusalText(refusal)).toBe(portuguese);
  });
});

describe("the words about a file", () => {
  it("gives each status a letter and a word", () => {
    expect(
      (["modified", "added", "deleted", "renamed", "copied"] as const).map((status) => [
        statusLetter(status),
        statusText(status),
      ]),
    ).toEqual([
      ["M", "Modified"],
      ["A", "Added"],
      ["D", "Deleted"],
      ["R", "Renamed"],
      ["C", "Copied"],
    ]);
    setLanguage("pt-BR");
    expect(statusText("deleted")).toBe("Removido");
  });

  it("says why a file has no lines to show", () => {
    const base = { path: "f", status: "modified" as const, hunks: [], added: 0, removed: 0 };
    expect(fileNote({ ...base, binary: true })).toBe(
      "Git does not show the lines of a binary file.",
    );
    expect(fileNote({ ...base, binary: false, oldMode: "100644", newMode: "100755" })).toBe(
      "The file mode changed from 100644 to 100755.",
    );
    expect(fileNote({ ...base, binary: false, status: "renamed" })).toBe(
      "The content did not change.",
    );
    expect(fileNote({ ...base, binary: false, status: "added" })).toBe("The file is empty.");
    expect(
      fileNote({
        ...base,
        binary: false,
        hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 0, heading: "", lines: [] }],
      }),
    ).toBeUndefined();
  });
});

describe("the title of a diff pane", () => {
  it("is the last part of the folder", () => {
    expect(diffTitle("/home/me/project")).toBe("Changes in project");
    expect(diffTitle("C:\\Users\\me\\repo\\")).toBe("Changes in repo");
    expect(diffTitle("/")).toBe("Changes in /");
    expect(diffTitle(undefined)).toBe("Git diff");
    setLanguage("pt-BR");
    expect(diffTitle("/home/me/project")).toBe("Mudanças em project");
  });
});

describe("the notices of the command that opens a diff", () => {
  it("say why nothing opened, in both languages", () => {
    expect(noFolderNotice()).toBe("This pane has no known folder, so there is no diff to show.");
    expect(badFolderNotice()).toBe("The folder of this pane is not one a diff can be read in.");
    expect(diffLimitNotice(4)).toBe("A tab holds at most 4 panes, so the diff was not opened.");
    setLanguage("pt-BR");
    expect(noFolderNotice()).toBe(
      "Este painel não tem uma pasta conhecida, então não há diff para mostrar.",
    );
    expect(badFolderNotice()).toBe("A pasta deste painel não é uma em que um diff possa ser lido.");
    expect(diffLimitNotice(4)).toBe(
      "Uma aba tem no máximo 4 painéis, então o diff não foi aberto.",
    );
  });
});
