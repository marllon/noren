import { z } from "zod";
import { DEFAULT_PROFILE_ID } from "./factories";
import { treeGroups } from "./tree";
import type { Id, Workspace } from "./types";

// Routing rules: where a new tab goes. A rule of `routing.rules` in `config.jsonc` names a space (and
// maybe a group in it) and says which tabs go there by the folder (`cwd`, a glob) or by the program
// the tab runs (`command`, a regular expression). `routeNewTab` is the pure choice: it reads no
// clock, system or file, so the folder of the user and the kind of system are arguments.

/** Most rules a file may hold, and the longest a glob, a pattern or a name may be. */
export const MAX_ROUTING_RULES = 100;
export const MAX_ROUTING_GLOB = 512;
export const MAX_ROUTING_PATTERN = 256;
export const MAX_ROUTING_NAME = 128;

/** Longest folder or command line that is looked at; a longer one matches no rule. */
export const MAX_ROUTING_SUBJECT = 4096;

/** The text of a regular expression that cannot be compiled, or `undefined` when it can. */
export function commandPatternProblem(pattern: string): string | undefined {
  try {
    new RegExp(pattern);
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `Not a valid regular expression: ${reason}`;
  }
}

/** True when the text has a control character (a line break, a NUL...). */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const nameSchema = (what: string) =>
  z
    .string()
    .max(MAX_ROUTING_NAME)
    .regex(/\S/, `The ${what} name is empty`)
    .refine((name) => !hasControl(name), { message: `The ${what} name has a control character` });

const RULE_NEEDS_A_MATCH = 'A rule needs "cwd", "command" or both';

export const RoutingRuleSchema = z
  .strictObject({
    cwd: z
      .string()
      .max(MAX_ROUTING_GLOB)
      .regex(/\S/, "The glob is empty")
      .refine((glob) => !hasControl(glob), { message: "The glob has a control character" })
      .optional()
      .meta({
        description:
          'A glob for the whole folder of the tab: "*" is any characters inside one folder name, "**" is any number of folders, "?" is one character, "~" at the start is your home folder. "/" and "\\" are the same on Windows, which also ignores upper and lower case. Write it with "/" to work on every system.',
      }),
    command: z
      .string()
      .max(MAX_ROUTING_PATTERN)
      .min(1)
      .superRefine((pattern, context) => {
        const problem = commandPatternProblem(pattern);
        if (problem !== undefined) context.addIssue({ code: "custom", message: problem });
      })
      .optional()
      .meta({
        description:
          'A regular expression (JavaScript syntax) for the line the tab runs: the profile and its arguments, as in "pwsh -NoLogo". It matches anywhere in the line; anchor it with ^ and $ to match the whole line.',
      }),
    space: nameSchema("space").meta({
      description:
        "The name of the space the tab goes to. A rule whose space does not exist is skipped.",
    }),
    group: nameSchema("group").optional().meta({
      description:
        "The name of a group in that space to put the tab in. Without it the tab goes to the space itself. A rule whose group is not in the space is skipped.",
    }),
  })
  .superRefine((rule, context) => {
    if (rule.cwd === undefined && rule.command === undefined) {
      context.addIssue({ code: "custom", message: RULE_NEEDS_A_MATCH });
    }
  })
  .meta({ description: "One routing rule." });

export type RoutingRule = z.infer<typeof RoutingRuleSchema>;

/** The rules of `routing.rules`, in the order they are tried. */
export const RoutingSchema = z
  .strictObject({
    rules: z.array(RoutingRuleSchema).max(MAX_ROUTING_RULES).optional().meta({
      description:
        'The rules for a new tab, tried in the order of the file: the first one that matches decides the space (and the group). A rule with "cwd" and "command" needs both to match.',
    }),
  })
  .meta({
    description:
      "Where a new tab goes: rules that match the folder or the command of the tab and name a space and a group. A tab that no rule matches goes where it would have gone.",
  });

/** The kind of system, which decides how a path is read: Windows ignores case and reads `\` as `/`. */
export type RoutingPlatform = "windows" | "unix";

/** What the rules are matched against. Either part may be missing; a rule that needs it then does not match. */
export interface RoutingTarget {
  /** The folder of the new tab. */
  cwd?: string | undefined;
  /** The line the tab runs: the profile and its arguments. */
  command?: string | undefined;
}

/** What the match depends on besides the rules and the workspace. */
export interface RoutingContext {
  platform: RoutingPlatform;
  /** The home folder of the user, which `~` stands for. Without it `~` in a glob matches nothing. */
  home?: string | undefined;
}

/** The rules for a new tab and what matching them depends on, as the app has them now. */
export interface NewTabRouting {
  /** `routing.rules` of the settings; none when the user wrote none. */
  rules: readonly RoutingRule[] | undefined;
  /** The kind of system and the home folder, which the match reads as arguments. */
  context: RoutingContext;
}

/** Where the rules send a tab: the space, and the group in it when the rule names one. */
export interface RoutingDestination {
  spaceId: Id;
  groupId?: Id;
}

/** A path as the matcher reads it: `/` for the separator, no trailing one, no case on Windows. */
function normalizePath(path: string, platform: RoutingPlatform): string {
  let text = platform === "windows" ? path.replaceAll("\\", "/").toLowerCase() : path;
  if (text.length > 1) text = text.replace(/\/+$/, "") || "/";
  return text;
}

/** `path` with a leading `~` replaced by `home`; as it is when there is no home to put. */
function expandHome(path: string, home: string | undefined): string {
  if (home === undefined) return path;
  if (path !== "~" && !path.startsWith("~/") && !path.startsWith("~\\")) return path;
  return home + path.slice(1);
}

type GlobToken =
  | { kind: "char"; char: string }
  | { kind: "one" } // ?
  | { kind: "star" } // *
  | { kind: "deep" } // ** (also across folders)
  | { kind: "deep-folders" }; // **/ (any number of folders, maybe none)

/** The tokens of a glob; the characters of `literal` (a home folder) are never wildcards. */
function globTokens(glob: string, literalPrefix: string): GlobToken[] {
  const tokens: GlobToken[] = [...literalPrefix].map((char) => ({ kind: "char", char }));
  for (let i = 0; i < glob.length;) {
    const char = glob.charAt(i);
    if (char === "?") {
      tokens.push({ kind: "one" });
      i++;
    } else if (char === "*") {
      let end = i;
      while (glob.charAt(end) === "*") end++;
      if (end - i === 1) tokens.push({ kind: "star" });
      else if (glob.charAt(end) === "/") {
        tokens.push({ kind: "deep-folders" });
        end++;
      } else tokens.push({ kind: "deep" });
      i = end;
    } else {
      tokens.push({ kind: "char", char });
      i++;
    }
  }
  return tokens;
}

/** Whether the glob tokens match the whole of `text`. Linear in the tokens times the text: no backtracking. */
function tokensMatch(tokens: readonly GlobToken[], text: string): boolean {
  const n = text.length;
  let reach = new Uint8Array(n + 1);
  reach[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(n + 1);
    switch (token.kind) {
      case "char":
        for (let j = 0; j < n; j++)
          if (reach[j] === 1 && text.charAt(j) === token.char) next[j + 1] = 1;
        break;
      case "one":
        for (let j = 0; j < n; j++) if (reach[j] === 1 && text.charAt(j) !== "/") next[j + 1] = 1;
        break;
      case "star":
        for (let j = 0; j <= n; j++) {
          if (reach[j] === 1) next[j] = 1;
          else if (j > 0 && next[j - 1] === 1 && text.charAt(j - 1) !== "/") next[j] = 1;
        }
        break;
      case "deep":
        for (let j = 0; j <= n; j++) {
          if (reach[j] === 1 || (j > 0 && next[j - 1] === 1)) next[j] = 1;
        }
        break;
      case "deep-folders": {
        let seen = false;
        for (let j = 0; j <= n; j++) {
          if (reach[j] === 1) next[j] = 1;
          if (j > 0 && seen && text.charAt(j - 1) === "/") next[j] = 1;
          if (reach[j] === 1) seen = true;
        }
        break;
      }
    }
    reach = next;
  }
  return reach[n] === 1;
}

/**
 * Whether `path` is matched by `glob` as a whole. `*` is any characters inside one folder name, `**`
 * any characters (`**` + `/` is any number of folders, even none; a glob that ends in `/**` also matches the folder itself), `?` one character that is not a
 * separator, and `~` at the start of the glob or of the path is `context.home`. On Windows `\` and
 * `/` are the same and case does not matter. Never throws.
 */
export function globMatchesPath(glob: string, path: string, context: RoutingContext): boolean {
  if (glob === "" || glob.length > MAX_ROUTING_GLOB || path.length > MAX_ROUTING_SUBJECT)
    return false;
  const { platform, home } = context;
  const wantsHome = glob === "~" || glob.startsWith("~/") || glob.startsWith("~\\");
  if (wantsHome && home === undefined) return false;
  let body = wantsHome ? glob.slice(1) : glob;
  if (platform === "windows") body = body.replaceAll("\\", "/").toLowerCase();
  body = body.replace(/\/+$/, "");
  if (body === "" && !wantsHome) body = "/";
  // The home folder is text, not a pattern: `*` or `?` in it stay what they are.
  const prefix = wantsHome ? normalizePath(home ?? "", platform).replace(/\/+$/, "") : "";
  const subject = normalizePath(expandHome(path, home), platform);
  if (tokensMatch(globTokens(body, prefix), subject)) return true;
  // A glob that ends in `/**` is "this folder and everything under it".
  if (!body.endsWith("/**")) return false;
  const folder = body.slice(0, -3);
  return tokensMatch(globTokens(folder === "" && !wantsHome ? "/" : folder, prefix), subject);
}

/** Whether the line matches the regular expression; a pattern that cannot compile matches nothing. */
export function commandMatches(pattern: string, command: string): boolean {
  if (pattern.length > MAX_ROUTING_PATTERN) return false;
  try {
    return new RegExp(pattern).test(command.slice(0, MAX_ROUTING_SUBJECT));
  } catch {
    return false;
  }
}

/** Whether one rule matches the target: what it names must all match, and it must name something. */
function ruleMatches(rule: RoutingRule, target: RoutingTarget, context: RoutingContext): boolean {
  if (rule.cwd === undefined && rule.command === undefined) return false;
  if (rule.cwd !== undefined) {
    if (target.cwd === undefined || !globMatchesPath(rule.cwd, target.cwd, context)) return false;
  }
  if (rule.command !== undefined) {
    if (target.command === undefined || !commandMatches(rule.command, target.command)) return false;
  }
  return true;
}

/** The first of `items` named `name`: by the exact name, else ignoring case and the blanks at the ends. */
function byName<T extends { name: string }>(items: readonly T[], name: string): T | undefined {
  const exact = items.find((item) => item.name === name);
  if (exact !== undefined) return exact;
  const wanted = name.trim().toLowerCase();
  return items.find((item) => item.name.trim().toLowerCase() === wanted);
}

/**
 * Where a new tab goes. The rules are tried in the order they are given and the first one that
 * matches decides, with the space (and the group in it) found by name in `workspace`. A rule whose
 * space or group is not there is skipped, and the next one is tried; a group is looked up in the
 * tree of its space, an outer one before an inner one. Without a match the answer is `undefined`:
 * the tab goes where it would have gone. Never throws, and reads nothing but its arguments.
 */
export function routeNewTab(
  rules: readonly RoutingRule[] | undefined,
  target: RoutingTarget,
  workspace: Pick<Workspace, "spaces">,
  context: RoutingContext,
): RoutingDestination | undefined {
  for (const rule of rules ?? []) {
    if (!ruleMatches(rule, target, context)) continue;
    const space = byName(workspace.spaces, rule.space);
    if (space === undefined) continue;
    if (rule.group === undefined) return { spaceId: space.id };
    const group = byName(treeGroups(space.tree), rule.group);
    if (group === undefined) continue;
    return { spaceId: space.id, groupId: group.id };
  }
  return undefined;
}

/**
 * Where a new tab of the app goes, for the page and for the local API alike: the destination of the
 * first routing rule that matches, else the active space. What the tab would have used without a
 * rule is what the rules are asked about: the folder is the one asked for, else the start folder of
 * the active space; the command is the profile asked for, else the profile of the active space,
 * else the default one. `routing` is read now, so a change in the settings counts at the next tab;
 * a getter that throws, or answers nothing or no rules, counts as no rules and the tab is still
 * made. Never throws.
 */
export function destinationOfNewTab(
  workspace: Pick<Workspace, "spaces" | "activeSpaceId">,
  params: { cwd?: string | undefined; profileId?: string | undefined },
  routing: (() => NewTabRouting | undefined) | undefined,
): RoutingDestination {
  const active: RoutingDestination = { spaceId: workspace.activeSpaceId };
  let rules: NewTabRouting | undefined;
  try {
    rules = routing?.();
  } catch {
    return active;
  }
  if (rules === undefined || rules.rules === undefined || rules.rules.length === 0) return active;
  const defaults = workspace.spaces.find((s) => s.id === workspace.activeSpaceId)?.defaults;
  const target = {
    cwd: params.cwd ?? defaults?.cwd,
    command: params.profileId ?? defaults?.profileId ?? DEFAULT_PROFILE_ID,
  };
  return routeNewTab(rules.rules, target, workspace, rules.context) ?? active;
}
