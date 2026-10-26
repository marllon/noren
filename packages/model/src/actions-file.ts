import { z } from "zod";

/** Where the file lives, relative to the default folder of a space. */
export const ACTIONS_FILE_PATH = ".noren/actions.json";

const text = (name: string) =>
  z
    .string({ error: `${name} must be a string` })
    .trim()
    .min(1, { error: `${name} must not be empty` });

const actionSchema = z.object({
  id: text("id"),
  label: text("label"),
  /** Typed into the tab, followed by Enter. */
  command: text("command"),
  /** Run in a short process with no tab; without it, stopping ends the session of the tab. */
  stop: text("stop").optional(),
  /**
   * With a `stop` command: once it ends with code 0 the sessions of the tab are left alone and the
   * action is "stopping" until they end on their own (the user can still end them at once).
   */
  stopWaits: z.boolean({ error: "stopWaits must be true or false" }).optional(),
  /** Name of the tab the action runs in. */
  tab: text("tab"),
  /** The action the Start and Stop button of the space's one-line block in the sidebar runs. */
  main: z.boolean({ error: "main must be true or false" }).optional(),
});

const fileSchema = z.object({
  actions: z
    .array(actionSchema, { error: "actions must be a list" })
    .superRefine((actions, ctx) => {
      const seen = new Set<string>();
      actions.forEach((action, index) => {
        if (!seen.has(action.id)) {
          seen.add(action.id);
          return;
        }
        ctx.addIssue({
          code: "custom",
          message: `Duplicate action id "${action.id}"`,
          path: [index, "id"],
        });
      });
    }),
});

/** One entry of `.noren/actions.json`. */
export type ProjectAction = z.infer<typeof actionSchema>;

export type ParseActionsResult =
  { ok: true; actions: ProjectAction[] } | { ok: false; reason: string };

function describe(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>(
    (out, part) =>
      typeof part === "number" ? `${out}[${part}]` : out ? `${out}.${String(part)}` : String(part),
    "",
  );
}

/**
 * Parses the text of `.noren/actions.json`. Never throws: a broken file, a wrong type, a missing
 * field or a repeated id comes back as `{ ok: false, reason }`, with the reason naming the place
 * (and, for a repeated id, the id).
 */
export function parseActionsFile(source: string): ParseActionsResult {
  let json: unknown;
  try {
    json = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `Not valid JSON: ${detail}` };
  }
  const parsed = fileSchema.safeParse(json);
  if (parsed.success) return { ok: true, actions: parsed.data.actions };
  const reason = parsed.error.issues
    .map((issue) => {
      const where = describe(issue.path);
      return where ? `${where}: ${issue.message}` : issue.message;
    })
    .join("; ");
  return { ok: false, reason: reason || "Invalid actions file" };
}
