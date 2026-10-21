import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { configJsonSchema, describeConfigError, parseConfigText } from "./config";
import { createEmptySpace } from "./factories";
import {
  MAX_ROUTING_GLOB,
  MAX_ROUTING_PATTERN,
  MAX_ROUTING_RULES,
  commandMatches,
  globMatchesPath,
  routeNewTab,
} from "./routing";
import type { RoutingContext, RoutingRule } from "./routing";
import type { GroupNode, Space, Workspace } from "./types";

// The `routing` key of `config.jsonc` and the pure choice of where a new tab goes.

const WIN: RoutingContext = { platform: "windows", home: "C:\\Users\\Ana" };
const UNIX: RoutingContext = { platform: "unix", home: "/home/ana" };

function group(id: string, name: string, children: GroupNode[] = []): GroupNode {
  return { kind: "group", id, name, color: "#000000", collapsed: false, children };
}

/** Work (groups: Api, Web > Admin) and Play (no groups). */
function workspace(): Workspace {
  const work: Space = {
    ...createEmptySpace("s-work", "Work"),
    tree: [group("g-api", "Api"), group("g-web", "Web", [group("g-admin", "Admin")])],
  };
  const play = createEmptySpace("s-play", "Play");
  return {
    version: 2,
    spaces: [work, play],
    activeSpaceId: "s-work",
    favorites: [],
    closed: [],
    archive: [],
  };
}

const ws = workspace();

function rule(fields: Partial<RoutingRule> & { space: string }): RoutingRule {
  return fields;
}

/** The errors of a text, one line each, or an empty list when it is valid. */
function problems(text: string): string[] {
  const parsed = parseConfigText(text);
  return parsed.ok ? [] : parsed.errors.map(describeConfigError);
}

describe("the routing key of config.jsonc", () => {
  it("accepts rules with a folder, a command or both, and a group", () => {
    const text = `{
      "routing": {
        "rules": [
          { "cwd": "~/work/**", "space": "Work" },
          { "command": "^ssh ", "space": "Play", "group": "Fun" },
          { "cwd": "C:/code/*", "command": "node", "space": "Work", "group": "Api" },
        ],
      },
    }`;
    const parsed = parseConfigText(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.routing?.rules).toEqual([
      { cwd: "~/work/**", space: "Work" },
      { command: "^ssh ", space: "Play", group: "Fun" },
      { cwd: "C:/code/*", command: "node", space: "Work", group: "Api" },
    ]);
  });

  it("is optional, and so are its rules", () => {
    expect(parseConfigText("{}")).toEqual({ ok: true, config: {} });
    expect(parseConfigText('{ "routing": {} }')).toEqual({ ok: true, config: { routing: {} } });
    expect(parseConfigText('{ "routing": { "rules": [] } }').ok).toBe(true);
  });

  it("refuses a rule with neither a folder nor a command, at the line of the rule", () => {
    const text = '{\n  "routing": {\n    "rules": [\n      { "space": "Work" }\n    ]\n  }\n}\n';
    const [first, ...others] = problems(text);
    expect(first).toBe('line 4, column 7: routing.rules[0]: A rule needs "cwd", "command" or both');
    expect(others).toEqual([]);
  });

  it("refuses a rule without a space and one with an empty or blank name", () => {
    expect(problems('{ "routing": { "rules": [{ "cwd": "/a" }] } }')[0]).toMatch(
      /routing\.rules\[0\]\.space: /,
    );
    expect(problems('{ "routing": { "rules": [{ "cwd": "/a", "space": "  " }] } }')[0]).toMatch(
      /routing\.rules\[0\]\.space: The space name is empty/,
    );
    expect(
      problems('{ "routing": { "rules": [{ "cwd": "/a", "space": "A", "group": "" }] } }')[0],
    ).toMatch(/routing\.rules\[0\]\.group: The group name is empty/);
  });

  it("refuses a regular expression that does not compile, with its path and never throws", () => {
    const text =
      '{\n  "routing": { "rules": [\n    { "command": "(", "space": "Work" }\n  ] }\n}\n';
    const [first, ...others] = problems(text);
    expect(first).toMatch(
      /^line 3, column \d+: routing\.rules\[0\]\.command: Not a valid regular expression: /,
    );
    expect(others).toEqual([]);
    for (const bad of ["[a-", "*x", "a{2,1}", "(?<n", "\\"]) {
      const parsed = parseConfigText(
        JSON.stringify({ routing: { rules: [{ command: bad, space: "Work" }] } }),
      );
      expect(parsed.ok, bad).toBe(false);
    }
  });

  it("refuses an unknown field, in the routing and in a rule, naming it", () => {
    expect(problems('{ "routing": { "extra": 1 } }')).toEqual([
      'line 1, column 16: routing.extra: Unknown setting "extra"',
    ]);
    const [first] = problems(
      '{ "routing": { "rules": [{ "cwd": "/a", "space": "A", "regex": "x" }] } }',
    );
    expect(first).toMatch(/routing\.rules\[0\]\.regex: Unknown setting "regex"/);
  });

  it("refuses values of the wrong kind", () => {
    expect(problems('{ "routing": { "rules": {} } }')).not.toEqual([]);
    expect(problems('{ "routing": { "rules": [{ "cwd": 1, "space": "A" }] } }')).not.toEqual([]);
    expect(problems('{ "routing": { "rules": ["x"] } }')).not.toEqual([]);
    expect(problems('{ "routing": [] }')).not.toEqual([]);
  });

  it("limits the number of rules and the length of what a rule holds", () => {
    const one = { cwd: "/a", space: "A" };
    const many = (count: number) =>
      JSON.stringify({ routing: { rules: Array.from({ length: count }, () => one) } });
    expect(parseConfigText(many(MAX_ROUTING_RULES)).ok).toBe(true);
    expect(parseConfigText(many(MAX_ROUTING_RULES + 1)).ok).toBe(false);
    const with_ = (rule: object) => JSON.stringify({ routing: { rules: [rule] } });
    expect(parseConfigText(with_({ cwd: "a".repeat(MAX_ROUTING_GLOB), space: "A" })).ok).toBe(true);
    expect(parseConfigText(with_({ cwd: "a".repeat(MAX_ROUTING_GLOB + 1), space: "A" })).ok).toBe(
      false,
    );
    expect(
      parseConfigText(with_({ command: "a".repeat(MAX_ROUTING_PATTERN), space: "A" })).ok,
    ).toBe(true);
    expect(
      parseConfigText(with_({ command: "a".repeat(MAX_ROUTING_PATTERN + 1), space: "A" })).ok,
    ).toBe(false);
    expect(parseConfigText(with_({ cwd: "/a", space: "a".repeat(129) })).ok).toBe(false);
    expect(parseConfigText(with_({ cwd: "", space: "A" })).ok).toBe(false);
    expect(parseConfigText(with_({ command: "", space: "A" })).ok).toBe(false);
    expect(parseConfigText(with_({ cwd: "/a\nb", space: "A" })).ok).toBe(false);
  });

  it("is in the JSON Schema, described for the editor, and strict", () => {
    const schema = configJsonSchema() as {
      properties: Record<
        string,
        {
          description?: string;
          additionalProperties?: boolean;
          properties?: Record<string, unknown>;
        }
      >;
    };
    const routing = schema.properties["routing"];
    expect(routing?.description).toMatch(/Where a new tab goes/);
    expect(routing?.additionalProperties).toBe(false);
    const rules = routing?.properties?.["rules"] as {
      maxItems?: number;
      items?: {
        additionalProperties?: boolean;
        properties?: Record<string, { description?: string }>;
      };
    };
    expect(rules.maxItems).toBe(MAX_ROUTING_RULES);
    expect(rules.items?.additionalProperties).toBe(false);
    for (const field of ["cwd", "command", "space", "group"]) {
      expect(rules.items?.properties?.[field]?.description, field).toBeTruthy();
    }
  });
});

describe("globMatchesPath", () => {
  it("* is any characters inside one folder name", () => {
    expect(globMatchesPath("/home/ana/*", "/home/ana/code", UNIX)).toBe(true);
    expect(globMatchesPath("/home/ana/*", "/home/ana/code/app", UNIX)).toBe(false);
    expect(globMatchesPath("/home/ana/*", "/home/ana", UNIX)).toBe(false);
    expect(globMatchesPath("/home/ana/pro*", "/home/ana/projects", UNIX)).toBe(true);
    expect(globMatchesPath("/home/ana/*-app", "/home/ana/my-app", UNIX)).toBe(true);
    expect(globMatchesPath("/home/ana/*-app", "/home/ana/my-api", UNIX)).toBe(false);
  });

  it("** crosses folders, and **/ may also be no folder at all", () => {
    expect(globMatchesPath("/srv/**", "/srv/a/b/c", UNIX)).toBe(true);
    expect(globMatchesPath("/srv/**", "/srv/", UNIX)).toBe(true);
    expect(globMatchesPath("/srv/**", "/srv", UNIX)).toBe(true);
    expect(globMatchesPath("/srv/**", "/srvx", UNIX)).toBe(false);
    expect(globMatchesPath("/**", "/", UNIX)).toBe(true);
    expect(globMatchesPath("~/**", "/home/ana", UNIX)).toBe(true);
    expect(globMatchesPath("/srv/**/app", "/srv/app", UNIX)).toBe(true);
    expect(globMatchesPath("/srv/**/app", "/srv/a/b/app", UNIX)).toBe(true);
    expect(globMatchesPath("/srv/**/app", "/srv/a/b/other", UNIX)).toBe(false);
    expect(globMatchesPath("/srv/**/app", "/srv/a/xapp", UNIX)).toBe(false);
    expect(globMatchesPath("**/node_modules", "/a/b/node_modules", UNIX)).toBe(true);
    expect(globMatchesPath("**", "/anything/at/all", UNIX)).toBe(true);
    expect(globMatchesPath("/a/**/b/**/c", "/a/x/b/y/z/c", UNIX)).toBe(true);
    expect(globMatchesPath("/a/**/b/**/c", "/a/b/c", UNIX)).toBe(true);
    expect(globMatchesPath("/a/**/b/**/c", "/a/x/c", UNIX)).toBe(false);
  });

  it("? is one character that is not a separator", () => {
    expect(globMatchesPath("/v?", "/v1", UNIX)).toBe(true);
    expect(globMatchesPath("/v?", "/v12", UNIX)).toBe(false);
    expect(globMatchesPath("/v?", "/v", UNIX)).toBe(false);
    expect(globMatchesPath("/a?b", "/a/b", UNIX)).toBe(false);
  });

  it("matches the whole path, not a part of it", () => {
    expect(globMatchesPath("/home/ana", "/home/ana/code", UNIX)).toBe(false);
    expect(globMatchesPath("code", "/home/ana/code", UNIX)).toBe(false);
    expect(globMatchesPath("/home/ana", "/home/ana", UNIX)).toBe(true);
    expect(globMatchesPath("/home/ana/", "/home/ana", UNIX)).toBe(true);
    expect(globMatchesPath("/home/ana", "/home/ana/", UNIX)).toBe(true);
    expect(globMatchesPath("/", "/", UNIX)).toBe(true);
    expect(globMatchesPath("/", "/home", UNIX)).toBe(false);
  });

  it("~ is the home folder, in the glob and in the path", () => {
    expect(globMatchesPath("~/code/**", "/home/ana/code/app", UNIX)).toBe(true);
    expect(globMatchesPath("~/code/**", "/home/bob/code/app", UNIX)).toBe(false);
    expect(globMatchesPath("~", "/home/ana", UNIX)).toBe(true);
    expect(globMatchesPath("~/", "/home/ana", UNIX)).toBe(true);
    expect(globMatchesPath("~", "/home/ana/code", UNIX)).toBe(false);
    expect(globMatchesPath("~/*", "/home/ana/code", UNIX)).toBe(true);
    expect(globMatchesPath("/home/ana/code", "~/code", UNIX)).toBe(true);
    expect(globMatchesPath("~/code", "~/code", UNIX)).toBe(true);
    expect(globMatchesPath("~\\code\\**", "C:\\Users\\Ana\\code\\x", WIN)).toBe(true);
    // Only at the start: a ~ elsewhere is a character.
    expect(globMatchesPath("/tmp/~", "/tmp/~", UNIX)).toBe(true);
    expect(globMatchesPath("/tmp/~", "/tmp/home", UNIX)).toBe(false);
    expect(globMatchesPath("~x/**", "/home/anax/a", UNIX)).toBe(false);
  });

  it("~ matches nothing when there is no home folder, and the home is text, not a pattern", () => {
    expect(globMatchesPath("~/code", "/home/ana/code", { platform: "unix" })).toBe(false);
    expect(globMatchesPath("~/**", "/anything", { platform: "unix" })).toBe(false);
    const odd: RoutingContext = { platform: "unix", home: "/home/a*" };
    expect(globMatchesPath("~/x", "/home/a*/x", odd)).toBe(true);
    expect(globMatchesPath("~/x", "/home/abc/x", odd)).toBe(false);
  });

  it("on Windows / and \\ are the same and case does not matter", () => {
    expect(globMatchesPath("C:/Users/Ana/**", "c:\\users\\ana\\Code\\App", WIN)).toBe(true);
    expect(globMatchesPath("C:\\Work\\*", "C:/work/proj", WIN)).toBe(true);
    expect(globMatchesPath("c:\\work\\*", "C:\\WORK\\Proj\\", WIN)).toBe(true);
    expect(globMatchesPath("C:\\Work\\*", "C:\\Work\\a\\b", WIN)).toBe(false);
    expect(globMatchesPath("D:\\**", "C:\\x", WIN)).toBe(false);
    expect(globMatchesPath("~/Code", "C:\\users\\ANA\\code", WIN)).toBe(true);
  });

  it("on Unix case matters and \\ is an ordinary character", () => {
    expect(globMatchesPath("/Work/*", "/work/a", UNIX)).toBe(false);
    expect(globMatchesPath("/Work/*", "/Work/a", UNIX)).toBe(true);
    expect(globMatchesPath("/a/b", "/a\\b", UNIX)).toBe(false);
    expect(globMatchesPath("/a\\b", "/a\\b", UNIX)).toBe(true);
  });

  it("is never fooled by regex characters in a glob and never throws", () => {
    expect(globMatchesPath("/a.b/(c)+[d]$/^x|y", "/a.b/(c)+[d]$/^x|y", UNIX)).toBe(true);
    expect(globMatchesPath("/a.b", "/axb", UNIX)).toBe(false);
    expect(globMatchesPath("", "/a", UNIX)).toBe(false);
    expect(globMatchesPath("/a", "", UNIX)).toBe(false);
    expect(globMatchesPath("*", "", UNIX)).toBe(true);
    expect(globMatchesPath("a".repeat(MAX_ROUTING_GLOB + 1), "a", UNIX)).toBe(false);
    expect(globMatchesPath("/a", "a".repeat(5000), UNIX)).toBe(false);
  });

  it("does not blow up on a glob made to backtrack", () => {
    const glob = `${"*a".repeat(100)}b`;
    const path = "a".repeat(2000);
    const started = Date.now();
    expect(globMatchesPath(glob, path, UNIX)).toBe(false);
    expect(globMatchesPath("**/".repeat(100) + "z", "a/".repeat(1000), UNIX)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("commandMatches", () => {
  it("matches anywhere in the line unless anchored", () => {
    expect(commandMatches("ssh", "pwsh -c ssh host")).toBe(true);
    expect(commandMatches("^ssh", "pwsh -c ssh host")).toBe(false);
    expect(commandMatches("^pwsh( |$)", "pwsh")).toBe(true);
    expect(commandMatches("^pwsh$", "pwsh -NoLogo")).toBe(false);
    expect(commandMatches("node|deno", "deno run x")).toBe(true);
  });

  it("a pattern that does not compile matches nothing, and does not throw", () => {
    expect(commandMatches("(", "(")).toBe(false);
    expect(commandMatches("a".repeat(MAX_ROUTING_PATTERN + 1), "a")).toBe(false);
  });
});

describe("routeNewTab", () => {
  it("gives the space of the first rule that matches, in the order of the file", () => {
    const rules = [
      rule({ cwd: "/srv/**", space: "Play" }),
      rule({ cwd: "/srv/app", space: "Work" }),
    ];
    expect(routeNewTab(rules, { cwd: "/srv/app" }, ws, UNIX)).toEqual({ spaceId: "s-play" });
    expect(routeNewTab([...rules].reverse(), { cwd: "/srv/app" }, ws, UNIX)).toEqual({
      spaceId: "s-work",
    });
  });

  it("gives the group too, found by name in the space, an inner one as well", () => {
    expect(
      routeNewTab([rule({ cwd: "/a", space: "Work", group: "Api" })], { cwd: "/a" }, ws, UNIX),
    ).toEqual({ spaceId: "s-work", groupId: "g-api" });
    expect(
      routeNewTab([rule({ cwd: "/a", space: "Work", group: "Admin" })], { cwd: "/a" }, ws, UNIX),
    ).toEqual({ spaceId: "s-work", groupId: "g-admin" });
    // Without a group the tab goes to the space itself.
    expect(routeNewTab([rule({ cwd: "/a", space: "Work" })], { cwd: "/a" }, ws, UNIX)).toEqual({
      spaceId: "s-work",
    });
  });

  it("finds a space or a group by its name ignoring case, preferring the exact name", () => {
    expect(
      routeNewTab([rule({ cwd: "/a", space: "WORK", group: "api" })], { cwd: "/a" }, ws, UNIX),
    ).toEqual({
      spaceId: "s-work",
      groupId: "g-api",
    });
    const twins: Workspace = {
      ...ws,
      spaces: [createEmptySpace("s-1", "work"), createEmptySpace("s-2", "Work")],
    };
    expect(routeNewTab([rule({ cwd: "/a", space: "Work" })], { cwd: "/a" }, twins, UNIX)).toEqual({
      spaceId: "s-2",
    });
  });

  it("skips a rule whose space does not exist and tries the next one", () => {
    const rules = [rule({ cwd: "/a", space: "Gone" }), rule({ cwd: "/a", space: "Play" })];
    expect(routeNewTab(rules, { cwd: "/a" }, ws, UNIX)).toEqual({ spaceId: "s-play" });
    expect(routeNewTab([rules[0] as RoutingRule], { cwd: "/a" }, ws, UNIX)).toBeUndefined();
  });

  it("skips a rule whose group is not in the space (or is in another one)", () => {
    const rules = [
      rule({ cwd: "/a", space: "Work", group: "Nope" }),
      rule({ cwd: "/a", space: "Play", group: "Api" }),
      rule({ cwd: "/a", space: "Work", group: "Web" }),
    ];
    expect(routeNewTab(rules, { cwd: "/a" }, ws, UNIX)).toEqual({
      spaceId: "s-work",
      groupId: "g-web",
    });
  });

  it("needs both the folder and the command to match when a rule has both", () => {
    const rules = [rule({ cwd: "/a/**", command: "^pwsh", space: "Work" })];
    expect(routeNewTab(rules, { cwd: "/a/x", command: "pwsh -NoLogo" }, ws, UNIX)).toEqual({
      spaceId: "s-work",
    });
    expect(routeNewTab(rules, { cwd: "/b/x", command: "pwsh -NoLogo" }, ws, UNIX)).toBeUndefined();
    expect(routeNewTab(rules, { cwd: "/a/x", command: "bash" }, ws, UNIX)).toBeUndefined();
    expect(routeNewTab(rules, { cwd: "/a/x" }, ws, UNIX)).toBeUndefined();
    expect(routeNewTab(rules, { command: "pwsh" }, ws, UNIX)).toBeUndefined();
  });

  it("matches by the command alone, and by the folder alone", () => {
    const rules = [rule({ command: "ssh ", space: "Play" }), rule({ cwd: "/a", space: "Work" })];
    expect(routeNewTab(rules, { command: "ssh box" }, ws, UNIX)).toEqual({ spaceId: "s-play" });
    expect(routeNewTab(rules, { cwd: "/a" }, ws, UNIX)).toEqual({ spaceId: "s-work" });
    expect(routeNewTab(rules, { cwd: "/a", command: "ssh box" }, ws, UNIX)).toEqual({
      spaceId: "s-play",
    });
  });

  it("gives nothing when no rule matches, there are no rules or the target is empty", () => {
    const rules = [rule({ cwd: "/a", space: "Work" })];
    expect(routeNewTab(rules, { cwd: "/b" }, ws, UNIX)).toBeUndefined();
    expect(routeNewTab(rules, {}, ws, UNIX)).toBeUndefined();
    expect(routeNewTab([], { cwd: "/a" }, ws, UNIX)).toBeUndefined();
    expect(routeNewTab(undefined, { cwd: "/a" }, ws, UNIX)).toBeUndefined();
    expect(routeNewTab(rules, { cwd: "/a" }, { spaces: [] }, UNIX)).toBeUndefined();
  });

  it("never matches a rule that names neither folder nor command, nor throws on a bad pattern", () => {
    const loose = [{ space: "Work" }, { command: "(", space: "Work" }] as RoutingRule[];
    expect(routeNewTab(loose, { cwd: "/a", command: "x" }, ws, UNIX)).toBeUndefined();
  });

  it("uses the platform and the home folder it is given", () => {
    const rules = [rule({ cwd: "~/Code/**", space: "Work" })];
    expect(routeNewTab(rules, { cwd: "C:\\users\\ana\\code\\x" }, ws, WIN)).toEqual({
      spaceId: "s-work",
    });
    expect(routeNewTab(rules, { cwd: "C:\\users\\ana\\code\\x" }, ws, UNIX)).toBeUndefined();
    expect(routeNewTab(rules, { cwd: "/home/ana/Code/x" }, ws, UNIX)).toEqual({
      spaceId: "s-work",
    });
    expect(routeNewTab(rules, { cwd: "/home/ana/code/x" }, ws, UNIX)).toBeUndefined();
  });

  it("does not change the workspace or the rules", () => {
    const before = JSON.stringify(ws);
    const rules = Object.freeze([Object.freeze(rule({ cwd: "/a", space: "Work", group: "Web" }))]);
    routeNewTab(rules, { cwd: "/a" }, ws, UNIX);
    expect(JSON.stringify(ws)).toBe(before);
  });
});

describe("routing properties", () => {
  // Characters a folder name may be made of, without the ones a glob reads.
  const nameChar = fc.constantFrom(..."abcXYZ019 _.-+()[]{}$^|~".split(""));
  const folder = fc.string({ unit: nameChar, minLength: 1, maxLength: 8 }).filter((s) => s !== "~");
  const absolute = fc
    .array(folder, { minLength: 1, maxLength: 5 })
    .map((parts) => `/${parts.join("/")}`);

  it("a glob without wildcards matches its own path and no other", () => {
    fc.assert(
      fc.property(absolute, absolute, (a, b) => {
        expect(globMatchesPath(a, a, UNIX)).toBe(true);
        expect(globMatchesPath(a, b, UNIX)).toBe(a === b);
      }),
    );
  });

  it("on Windows a literal glob matches its path with the other separator and other case", () => {
    fc.assert(
      fc.property(absolute, (path) => {
        const other = path.replaceAll("/", "\\").toUpperCase();
        expect(globMatchesPath(path, other, WIN)).toBe(true);
      }),
    );
  });

  it("** after a folder matches everything under it, and * only the next level", () => {
    fc.assert(
      fc.property(absolute, fc.array(folder, { minLength: 1, maxLength: 4 }), (base, below) => {
        const path = `${base}/${below.join("/")}`;
        expect(globMatchesPath(`${base}/**`, path, UNIX)).toBe(true);
        expect(globMatchesPath(`${base}/*`, path, UNIX)).toBe(below.length === 1);
      }),
    );
  });

  it("never throws, whatever the glob, the path or the pattern", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.constantFrom(WIN, UNIX), (a, b, context) => {
        expect(typeof globMatchesPath(a, b, context)).toBe("boolean");
        expect(typeof commandMatches(a, b)).toBe("boolean");
        routeNewTab([{ cwd: a, command: b, space: "Work" }], { cwd: b, command: a }, ws, context);
      }),
    );
  });

  it("the answer is the first rule whose space exists, whatever the rules after it", () => {
    const ids: Record<string, string> = { Work: "s-work", Play: "s-play" };
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("Work", "Play", "Nowhere"), { maxLength: 8 }),
        (spaces) => {
          const rules = spaces.map((space) => rule({ cwd: "/a", space }));
          const first = spaces.find((space) => space !== "Nowhere");
          const got = routeNewTab(rules, { cwd: "/a" }, ws, UNIX);
          expect(got).toEqual(first === undefined ? undefined : { spaceId: ids[first] });
        },
      ),
    );
  });
});
