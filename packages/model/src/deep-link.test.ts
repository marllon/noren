import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createDefaultWorkspace, findSpaceByFolder, parseDeepLink, sameFolder } from "./index";
import type { Workspace } from "./index";
import { spaceNameForFolder } from "./index";

const enc = encodeURIComponent;

/** True when the text has a control character. */
function hasControlChar(text: string): boolean {
  return [...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
}

function linkOf(url: string) {
  const result = parseDeepLink(url);
  if (!result.ok) throw new Error(`expected the link to be accepted: ${result.reason}`);
  return result.link;
}

function reasonOf(url: string): string {
  const result = parseDeepLink(url);
  if (result.ok) throw new Error("expected the link to be refused");
  return result.reason;
}

describe("parseDeepLink: accepted", () => {
  it("open with a POSIX folder", () => {
    expect(linkOf("noren://open?path=/srv/proj")).toEqual({ kind: "open", path: "/srv/proj" });
  });

  it("open with a Windows folder, encoded or not", () => {
    expect(linkOf(`noren://open?path=${enc("C:\\Users\\ada\\dev")}`)).toEqual({
      kind: "open",
      path: "C:\\Users\\ada\\dev",
    });
    expect(linkOf("noren://open?path=C:/Users/ada/dev")).toEqual({
      kind: "open",
      path: "C:/Users/ada/dev",
    });
  });

  it("a UNC folder", () => {
    expect(linkOf(`noren://open?path=${enc("\\\\server\\share\\proj")}`)).toEqual({
      kind: "open",
      path: "\\\\server\\share\\proj",
    });
  });

  it("action with a folder and an id", () => {
    expect(linkOf("noren://action?path=/srv/proj&id=dev")).toEqual({
      kind: "action",
      path: "/srv/proj",
      id: "dev",
    });
  });

  it("a folder with a space and an accent, percent-encoded", () => {
    const path = "/home/jo\u00e3o/meus projetos/caf\u00e9";
    expect(linkOf(`noren://open?path=${enc(path)}`)).toEqual({ kind: "open", path });
    expect(linkOf("noren://open?path=/home/jo%C3%A3o/meus%20projetos/caf%C3%A9")).toEqual({
      kind: "open",
      path,
    });
    expect(
      linkOf(`noren://action?path=${enc("C:\\Users\\Jo\u00e3o\\Meus Projetos")}&id=loop`),
    ).toEqual({ kind: "action", path: "C:\\Users\\Jo\u00e3o\\Meus Projetos", id: "loop" });
  });

  it("an action id with a space or an accent", () => {
    expect(linkOf(`noren://action?path=/p&id=${enc("build \u00e7")}`)).toMatchObject({
      id: "build \u00e7",
    });
  });

  it("parameters in either order, the scheme and host in any case, a slash after the host", () => {
    expect(linkOf("noren://action?id=dev&path=/p")).toEqual({
      kind: "action",
      path: "/p",
      id: "dev",
    });
    expect(linkOf("NOREN://Open?path=/p")).toEqual({ kind: "open", path: "/p" });
    expect(linkOf("noren://open/?path=/p")).toEqual({ kind: "open", path: "/p" });
    expect(linkOf("  noren://open?path=/p \n")).toEqual({ kind: "open", path: "/p" });
  });

  it("a plus stays a plus", () => {
    expect(linkOf("noren://open?path=/a+b")).toEqual({ kind: "open", path: "/a+b" });
  });

  it("a dot segment that is not .. and a name that merely contains dots", () => {
    expect(linkOf("noren://open?path=/srv/a..b/.hidden/.")).toMatchObject({ kind: "open" });
  });

  it("trims the id like the actions file does", () => {
    expect(linkOf("noren://action?path=/p&id=%20dev%20")).toMatchObject({ id: "dev" });
  });
});

describe("parseDeepLink: refused", () => {
  it.each([
    ["", "start with noren://"],
    ["https://example.com/?path=/p", "start with noren://"],
    ["noren:open?path=/p", "not of the form"],
    ["noren://", "no kind"],
    ["noren://?path=/p", "no kind"],
    ["noren://run?path=/p", 'unknown link kind "run"'],
    ["noren://openx?path=/p", "unknown link kind"],
    ["noren://open", "no parameters"],
    ["noren://open?", "no parameters"],
    ["noren://open/extra?path=/p", "not of the form"],
    ["noren://open?path=/p#frag", "fragment"],
    ["noren://open?path=", "empty"],
    ["noren://open?path", "empty"],
    ["noren://open?id=dev", 'does not take the parameter "id"'],
    ["noren://action?id=dev", '"path" parameter is missing'],
    ["noren://action?path=/p", '"id" parameter is missing'],
    ["noren://action?path=/p&id=", "id is empty"],
    ["noren://action?path=/p&id=%20%20", "id is empty"],
    ["noren://open?path=/a&path=/b", "repeated"],
    ["noren://action?path=/p&id=a&id=b", "repeated"],
    ["noren://open?path=/p&", "empty parameter name"],
    ["noren://open?path=%E0%A4%A", "percent-encoding"],
    ["noren://open?path=%ZZ", "percent-encoding"],
  ])("%j", (url, part) => {
    expect(reasonOf(url)).toContain(part);
  });

  it.each(["relative/dir", "./dir", "~/dir", "C:dir", "file:///srv/proj", "srv/proj"])(
    "a folder that is not absolute: %j",
    (path) => {
      expect(reasonOf(`noren://open?path=${enc(path)}`)).toContain("absolute");
    },
  );

  it.each([
    "/srv/../etc",
    "/srv/proj/..",
    "C:\\Users\\ada\\..\\root",
    "C:/a/../b",
    "\\\\server\\share\\..\\x",
    "/srv/%2e%2e/etc",
  ])("a folder with a .. segment: %j", (path) => {
    const url = path.includes("%") ? `noren://open?path=${path}` : `noren://open?path=${enc(path)}`;
    expect(reasonOf(url)).toContain("..");
  });

  it("a control character in the folder or the id", () => {
    expect(reasonOf("noren://open?path=/p%00x")).toContain("control");
    expect(reasonOf("noren://open?path=/p%0Ax")).toContain("control");
    expect(reasonOf("noren://action?path=/p&id=a%0Db")).toContain("control");
  });

  it("a folder or id that is too long", () => {
    expect(reasonOf(`noren://open?path=/${"a".repeat(5000)}`)).toContain("too long");
    expect(reasonOf(`noren://action?path=/p&id=${"a".repeat(5000)}`)).toContain("too long");
  });
});

describe("parseDeepLink: a command in the URL is refused", () => {
  it.each([
    "noren://action?path=/p&id=dev&command=rm%20-rf%20%2F",
    "noren://action?path=/p&id=dev&cmd=calc",
    "noren://action?path=/p&id=dev&args=--x",
    "noren://action?path=/p&command=pnpm%20dev",
    "noren://open?path=/p&command=pnpm%20dev",
    "noren://open?path=/p&cmd=ls",
    "noren://open?path=/p&run=1",
    "noren://open?path=/p&id=dev",
    "noren://action?path=/p&id=dev&stop=x",
    "noren://action?path=/p&id=dev&Command=x",
    "noren://action?path=/p&id=dev&%63ommand=x",
    "noren://open?path=/p&path2=/q",
  ])("%s", (url) => {
    expect(reasonOf(url)).toContain("does not take the parameter");
  });

  it("a command as the host or hidden in the path is refused too", () => {
    expect(parseDeepLink("noren://command?path=/p").ok).toBe(false);
    expect(parseDeepLink("noren://run/pnpm%20dev").ok).toBe(false);
  });

  it("any accepted link carries only a folder and an id", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (text) => {
        const result = parseDeepLink(`noren://action?path=/p&id=x&${text}`);
        if (result.ok) expect(Object.keys(result.link).sort()).toEqual(["id", "kind", "path"]);
      }),
    );
  });

  it("never throws, whatever the text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        parseDeepLink(text);
        parseDeepLink(`noren://open?path=${text}`);
        parseDeepLink(`noren://action?${text}`);
      }),
    );
  });

  it("round-trips any absolute folder without .. through percent-encoding", () => {
    const segment = fc
      .string({ unit: "grapheme", minLength: 1, maxLength: 12 })
      .filter((s) => !/[\\/]/.test(s) && !hasControlChar(s) && s !== "..");
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), (parts) => {
        const path = `/${parts.join("/")}`;
        expect(parseDeepLink(`noren://open?path=${enc(path)}`)).toEqual({
          ok: true,
          link: { kind: "open", path },
        });
      }),
    );
  });
});

describe("sameFolder", () => {
  it("treats / and \\ as the same separator", () => {
    expect(sameFolder("C:\\Users\\ada\\dev", "C:/Users/ada/dev")).toBe(true);
    expect(sameFolder("\\\\srv\\share\\p", "//srv/share/p")).toBe(true);
  });

  it("ignores a trailing separator", () => {
    expect(sameFolder("/srv/proj/", "/srv/proj")).toBe(true);
    expect(sameFolder("C:\\dev\\", "C:/dev")).toBe(true);
    expect(sameFolder("/srv/proj//", "/srv/proj")).toBe(true);
  });

  it("is case-insensitive for Windows-style paths only", () => {
    expect(sameFolder("c:\\users\\Ada\\DEV", "C:\\Users\\ada\\dev")).toBe(true);
    expect(sameFolder("\\\\SRV\\Share\\p", "//srv/share/P")).toBe(true);
    expect(sameFolder("/srv/Proj", "/srv/proj")).toBe(false);
  });

  it("tells different folders apart, and a folder from its sibling with the same prefix", () => {
    expect(sameFolder("/srv/proj", "/srv/proj2")).toBe(false);
    expect(sameFolder("/srv/proj", "/srv")).toBe(false);
    expect(sameFolder("C:\\a", "D:\\a")).toBe(false);
    expect(sameFolder("/", "/")).toBe(true);
    expect(sameFolder("C:\\", "C:/")).toBe(true);
    expect(sameFolder("/", "/srv")).toBe(false);
  });

  it("keeps accents exact", () => {
    expect(sameFolder("/home/jo\u00e3o", "/home/joao")).toBe(false);
    expect(sameFolder("/home/jo\u00e3o", "/home/jo\u00e3o/")).toBe(true);
  });

  it("is symmetric and reflexive", () => {
    const part = fc.constantFrom("a", "B", "c d", "\u00e9", "..x", "dev");
    const sep = fc.constantFrom("/", "\\", "//");
    const path = fc
      .tuple(
        fc.constantFrom("/", "C:\\", "c:/", "\\\\srv\\", "D:\\"),
        fc.array(fc.tuple(part, sep), { maxLength: 4 }),
        fc.constantFrom("", "/", "\\"),
      )
      .map(([root, parts, tail]) => root + parts.map(([p, s]) => p + s).join("") + tail);
    fc.assert(
      fc.property(path, path, (a, b) => {
        expect(sameFolder(a, a)).toBe(true);
        expect(sameFolder(a, b)).toBe(sameFolder(b, a));
      }),
    );
  });
});

describe("findSpaceByFolder", () => {
  const base = createDefaultWorkspace({
    newId: (
      (n) => () =>
        `n${(n += 1)}`
    )(0),
  });

  function withFolders(folders: (string | undefined)[], activeIndex = 0): Workspace {
    const template = base.spaces[0];
    if (!template) throw new Error("no template space");
    const spaces = folders.map((cwd, index) => ({
      ...template,
      id: `s${index}`,
      name: `S${index}`,
      defaults: { ...template.defaults, ...(cwd !== undefined ? { cwd } : {}) },
    }));
    return { ...base, spaces, activeSpaceId: `s${activeIndex}` };
  }

  it("finds the space whose default folder matches", () => {
    const ws = withFolders([undefined, "/srv/a", "C:\\Dev\\B"]);
    expect(findSpaceByFolder(ws, "/srv/a/")?.id).toBe("s1");
    expect(findSpaceByFolder(ws, "c:/dev/b")?.id).toBe("s2");
    expect(findSpaceByFolder(ws, "/srv/none")).toBeUndefined();
  });

  it("prefers the active space, else the first in order", () => {
    const ws = withFolders(["/srv/a", "/srv/a", "/srv/a"], 2);
    expect(findSpaceByFolder(ws, "/srv/a")?.id).toBe("s2");
    expect(findSpaceByFolder({ ...ws, activeSpaceId: "s9" }, "/srv/a")?.id).toBe("s0");
  });

  it("a space with no folder never matches", () => {
    expect(findSpaceByFolder(withFolders([undefined]), "/srv/a")).toBeUndefined();
  });
});

describe("spaceNameForFolder", () => {
  it("is the last segment", () => {
    expect(spaceNameForFolder("/srv/proj")).toBe("proj");
    expect(spaceNameForFolder("C:\\Users\\Jo\u00e3o\\Meus Projetos\\")).toBe("Meus Projetos");
    expect(spaceNameForFolder("\\\\srv\\share")).toBe("share");
  });

  it("falls back to the whole path for a root", () => {
    expect(spaceNameForFolder("/")).toBe("/");
    expect(spaceNameForFolder("C:\\")).toBe("C:\\");
  });
});
