import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_PREVIEW_PATH, previewPathProblem } from "./file-preview";
import { findOutputPaths, resolveOutputPath } from "./output-paths";

const paths = (line: string): string[] => findOutputPaths(line).map((match) => match.path);

describe("findOutputPaths: full paths", () => {
  it.each([
    ["see /home/me/notes.md for more", "/home/me/notes.md"],
    ["C:\\Users\\me\\notes.md", "C:\\Users\\me\\notes.md"],
    ["d:/work/notes.md", "d:/work/notes.md"],
    ["wrote /tmp/out", "/tmp/out"],
    ["/notes.md", "/notes.md"],
    ["file=/var/log/app.log", "/var/log/app.log"],
  ])("finds the path in %j", (line, path) => {
    expect(paths(line)).toEqual([path]);
  });

  it("marks where the link starts and ends", () => {
    const line = "see /home/me/notes.md now";
    const [match] = findOutputPaths(line);
    expect(match).toEqual({ start: 4, end: 21, path: "/home/me/notes.md" });
    expect(line.slice(match?.start, match?.end)).toBe("/home/me/notes.md");
  });

  it.each([
    ["only a drive", "C:\\"],
    ["only a root", "/"],
    ["a folder with a closing separator", "/home/me/"],
    ["a Windows option", "dir /s /b"],
    ["a verbatim Windows path", "\\\\?\\C:\\Users\\a.md"],
    ["a share", "\\\\server\\share\\a.md"],
    ["two slashes", "//host/share/a.md"],
    ["a drive without a separator", "C:a.md"],
    ["home", "~/notes.md"],
    ["an address", "https://example.com/docs/a.md"],
    ["an address with a port", "http://localhost:3000/docs/a.md and ftp://h/x/y.txt"],
    ["a file address", "file:///home/me/a.md"],
    ["a fraction", "1/2 and 3.14/2.71"],
    ["a name with no folder", "notes.md"],
  ])("does not find a path in %s", (_what, line) => {
    expect(paths(line)).toEqual([]);
  });
});

describe("findOutputPaths: relative paths", () => {
  it.each([
    ["./build.sh", "./build.sh"],
    [".\\build.ps1", ".\\build.ps1"],
    ["../Makefile", "../Makefile"],
    ["..\\..\\notes", "..\\..\\notes"],
    ["src/main.rs", "src/main.rs"],
    ["docs\\guide.md", "docs\\guide.md"],
    ["a/b/c/d.tar.gz", "a/b/c/d.tar.gz"],
  ])("finds %j", (line, path) => {
    expect(paths(`error in ${line} here`)).toEqual([path]);
  });

  it.each([
    ["a folder and a name without an extension", "src/main"],
    ["a version", "v1.2/3.4"],
    ["a hidden file with no name", "src/.gitignore"],
    ["a dot alone", "./"],
    ["dots alone", "./../"],
    ["an empty part", "src//main.rs"],
    ["a flag", "--out=build.log"],
    ["the ratio of a progress bar", "50/100"],
  ])("does not find a path in %s", (_what, line) => {
    expect(paths(line)).toEqual([]);
  });

  it("reads the path after an equals sign", () => {
    const line = "--out=./build/app.log";
    expect(findOutputPaths(line)).toEqual([{ start: 6, end: 21, path: "./build/app.log" }]);
  });

  it("finds more than one path on a line", () => {
    expect(paths("cp ./a.txt /tmp/b.txt && cat src/c.md")).toEqual([
      "./a.txt",
      "/tmp/b.txt",
      "src/c.md",
    ]);
  });
});

describe("findOutputPaths: quotes, punctuation and suffixes", () => {
  it.each([
    ['"/home/me/a b.md"', ["/home/me/a"]],
    ["'/home/me/notes.md'", ["/home/me/notes.md"]],
    ["`/home/me/notes.md`", ["/home/me/notes.md"]],
    ["(/home/me/notes.md)", ["/home/me/notes.md"]],
    ["[./notes.md]", ["./notes.md"]],
    ["<src/main.rs>", ["src/main.rs"]],
    ["saved to /tmp/notes.md.", ["/tmp/notes.md"]],
    ["saved to /tmp/notes.md,", ["/tmp/notes.md"]],
    ["did you mean /tmp/notes.md?", ["/tmp/notes.md"]],
    ["see /tmp/notes.md!", ["/tmp/notes.md"]],
    ["see /tmp/notes.md;", ["/tmp/notes.md"]],
    ["see /tmp/notes.md…", ["/tmp/notes.md"]],
    ["/tmp/a.md,/tmp/b.md", ["/tmp/a.md,/tmp/b.md"]],
    ["/usr/bin:/usr/local/bin", ["/usr/bin", "/usr/local/bin"]],
  ])("reads %j", (line, expected) => {
    expect(paths(line)).toEqual(expected);
  });

  it("takes a :line and a :line:column off the path and into the link", () => {
    const line = "error at src/main.rs:12:5: bad";
    const [match] = findOutputPaths(line);
    expect(match).toMatchObject({ path: "src/main.rs", line: 12, column: 5 });
    expect(line.slice(match?.start, match?.end)).toBe("src/main.rs:12:5");
  });

  it.each([
    ["/tmp/a.md:7", 7, undefined],
    ["/tmp/a.md:7:", 7, undefined],
    ["C:\\tmp\\a.md:7:30", 7, 30],
    ["./a.md:7:30:", 7, 30],
  ])("reads the suffix of %j", (line, row, column) => {
    const [match] = findOutputPaths(line);
    expect(match?.line).toBe(row);
    expect(match?.column).toBe(column);
    expect(match?.path).toBe(line.replace(/:\d+(:\d+)?:?$/, ""));
  });

  it("does not take a colon and a word for a suffix", () => {
    expect(findOutputPaths("/tmp/a.md:x")).toEqual([{ start: 0, end: 9, path: "/tmp/a.md" }]);
  });

  it("leaves an address alone even when a path follows it", () => {
    expect(paths("https://example.com/a.md /tmp/a.md")).toEqual(["/tmp/a.md"]);
  });

  it("finds nothing in a line with a control character in the middle of a path", () => {
    expect(paths("/tmp/a\u0001b.md")).toEqual(["/tmp/a"]);
  });

  it("skips a run longer than a preview path may be", () => {
    expect(findOutputPaths(`/${"a".repeat(MAX_PREVIEW_PATH)}.md`)).toEqual([]);
  });
});

describe("resolveOutputPath", () => {
  it("keeps a full path and writes it out without . and ..", () => {
    expect(resolveOutputPath("/home/me/./docs/../notes.md", undefined)).toEqual({
      ok: true,
      path: "/home/me/notes.md",
    });
    expect(resolveOutputPath("C:/Users/me/../you/notes.md", undefined)).toEqual({
      ok: true,
      path: "C:\\Users\\you\\notes.md",
    });
  });

  it("resolves a relative path against the folder of the pane", () => {
    expect(resolveOutputPath("./notes.md", "/home/me")).toEqual({
      ok: true,
      path: "/home/me/notes.md",
    });
    expect(resolveOutputPath("../notes.md", "/home/me/work/")).toEqual({
      ok: true,
      path: "/home/me/notes.md",
    });
    expect(resolveOutputPath("src/main.rs", "C:\\work")).toEqual({
      ok: true,
      path: "C:\\work\\src\\main.rs",
    });
    expect(resolveOutputPath("..\\docs\\a.md", "C:/work/app")).toEqual({
      ok: true,
      path: "C:\\work\\docs\\a.md",
    });
  });

  it("stops .. at the root", () => {
    expect(resolveOutputPath("../../../a.md", "/home")).toEqual({ ok: true, path: "/a.md" });
    expect(resolveOutputPath("../../a.md", "C:\\work")).toEqual({ ok: true, path: "C:\\a.md" });
  });

  it("has nothing to resolve a relative path against without a folder", () => {
    expect(resolveOutputPath("./a.md", undefined)).toEqual({ ok: false, problem: "no-folder" });
    expect(resolveOutputPath("./a.md", "")).toEqual({ ok: false, problem: "no-folder" });
    expect(resolveOutputPath("./a.md", "work")).toEqual({ ok: false, problem: "no-folder" });
  });

  it("refuses what lands on the network", () => {
    expect(resolveOutputPath("./a.md", "\\\\server\\share\\dir")).toEqual({
      ok: false,
      problem: "network",
    });
    expect(resolveOutputPath("./a.md", "//server/share")).toEqual({
      ok: false,
      problem: "network",
    });
  });

  it("refuses a path that is too long once it is resolved", () => {
    const folder = `/${"a".repeat(MAX_PREVIEW_PATH - 10)}`;
    expect(resolveOutputPath("./b".repeat(10) + ".md", folder)).toEqual({
      ok: false,
      problem: "invalid",
    });
  });
});

// Folders and names the way a program writes them: no separator, colon, quote or blank in a name.
const name = fc.stringMatching(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,7}$/);
const extension = fc.constantFrom("md", "png", "json", "txt", "rs", "tsx");
const folders = fc.array(name, { minLength: 1, maxLength: 5 });
const absolutePath = fc.oneof(
  fc
    .tuple(folders, name, extension)
    .map(([dirs, file, ext]) => `/${[...dirs, `${file}.${ext}`].join("/")}`),
  fc
    .tuple(fc.constantFrom("C", "d", "Z"), folders, name, extension)
    .map(([drive, dirs, file, ext]) => `${drive}:\\${[...dirs, `${file}.${ext}`].join("\\")}`),
);
const relativePath = fc
  .tuple(fc.constantFrom("", "./", "../", "../../"), folders, name, extension)
  .map(([lead, dirs, file, ext]) => `${lead}${[...dirs, `${file}.${ext}`].join("/")}`);
const before = fc.constantFrom("", "see ", "error in ", 'open "', "(", "`", "file=", "> ");
const after = fc.constantFrom("", " here", ".", ",", '"', ")", "`", "!", "?", ";");
const suffix = fc.constantFrom(
  { text: "", line: undefined, column: undefined },
  { text: ":12", line: 12, column: undefined },
  { text: ":7:30", line: 7, column: 30 },
);

describe("findOutputPaths: properties", () => {
  it("finds the path in any line it is written in, with its suffix", () => {
    fc.assert(
      fc.property(
        fc.oneof(absolutePath, relativePath),
        before,
        suffix,
        after,
        (path, lead, tail, end) => {
          // A suffix and then a ":" belong together; the closing quote or bracket ends the link.
          const line = `${lead}${path}${tail.text}${end}`;
          const found = findOutputPaths(line);
          expect(found.map((match) => match.path)).toEqual([path]);
          const [match] = found;
          expect(line.slice(match?.start, match?.end)).toBe(`${path}${tail.text}`);
          expect(match?.line).toBe(tail.line);
          expect(match?.column).toBe(tail.column);
        },
      ),
    );
  });

  it("gives ranges that are in the line, in order and apart, whatever the line", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (line) => {
        let last = 0;
        for (const match of findOutputPaths(line)) {
          expect(match.start).toBeGreaterThanOrEqual(last);
          expect(match.end).toBeGreaterThan(match.start);
          expect(match.end).toBeLessThanOrEqual(line.length);
          expect(line.slice(match.start).startsWith(match.path)).toBe(true);
          last = match.end;
        }
      }),
    );
  });

  it("does not see a path in the text of an address", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("http", "https", "ftp", "file"),
        fc.array(name, { minLength: 1, maxLength: 4 }),
        name,
        extension,
        (scheme, dirs, file, ext) => {
          const address = `${scheme}://${[...dirs, `${file}.${ext}`].join("/")}`;
          expect(findOutputPaths(`open ${address} now`)).toEqual([]);
        },
      ),
    );
  });
});

describe("resolveOutputPath: properties", () => {
  const cwd = fc.oneof(
    folders.map((dirs) => `/${dirs.join("/")}`),
    fc
      .tuple(fc.constantFrom("C", "e"), folders)
      .map(([drive, dirs]) => `${drive}:\\${dirs.join("\\")}`),
  );

  it("gives a full path the preview pane takes, with no . or .. in it", () => {
    fc.assert(
      fc.property(fc.oneof(absolutePath, relativePath), cwd, (path, folder) => {
        const resolved = resolveOutputPath(path, folder);
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        expect(previewPathProblem(resolved.path)).toBeUndefined();
        const parts = resolved.path.slice(resolved.path.startsWith("/") ? 1 : 0).split(/[\\/]/);
        expect(parts).not.toContain("..");
        expect(parts).not.toContain(".");
        expect(parts).not.toContain("");
      }),
    );
  });

  it("resolves a path that is already resolved to itself", () => {
    fc.assert(
      fc.property(fc.oneof(absolutePath, relativePath), cwd, (path, folder) => {
        const first = resolveOutputPath(path, folder);
        if (!first.ok) return;
        expect(resolveOutputPath(first.path, undefined)).toEqual(first);
      }),
    );
  });

  it("never throws and never gives a path the pane would refuse, for any text", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60 }),
        fc.option(fc.string({ maxLength: 30 })),
        (text, folder) => {
          const resolved = resolveOutputPath(text, folder ?? undefined);
          if (resolved.ok) expect(previewPathProblem(resolved.path)).toBeUndefined();
        },
      ),
    );
  });
});
