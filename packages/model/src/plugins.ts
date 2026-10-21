import { z } from "zod";
import { dispatchApiCall } from "./api-dispatch";
import type { ApiCall, ApiErrorCode, ApiHost, ApiJson } from "./api-dispatch";

// Plugins, the pure side (NOR-F18-01a): the manifest of a plugin, the messages a plugin and the
// app exchange (protocol v1) and the broker that answers one plugin's requests. No DOM, no Worker,
// no Tauri, no wall-clock time: the app lends the workspace and the shells through `ApiHost`, and
// whatever carries the messages (a Worker, a frame) is not here. Loading the folder and running the
// code come in NOR-F18-01b, the panel of the plugin in NOR-F18-01c.
//
// A plugin starts with no power. Its manifest names the permissions it asks for, and the broker
// looks at them before it looks at anything else of a request: a method whose permission the
// manifest does not hold is answered `permission_denied`, with the permission that was missing, and
// the host is not touched. Reading a terminal and making a tab go through `dispatchApiCall`, the
// same code the local API runs (so the same limits and the same errors); registering an action of
// the palette and opening a panel are only written down in a registry per plugin, which the host
// reads and shows (the interface is not here).

/** The version of the plugin API this build speaks; a manifest and every request carry it. */
export const PLUGIN_API_VERSION = 1;

/** What a plugin may ask for, the closed list. */
export const PLUGIN_PERMISSIONS = [
  "terminal.read",
  "tabs.create",
  "palette.actions",
  "panel",
] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** The methods of the plugin API, each held by the one permission that opens it. */
export const PLUGIN_METHODS = {
  "terminal.read": "terminal.read",
  "tabs.create": "tabs.create",
  "palette.register": "palette.actions",
  "panel.open": "panel",
} as const satisfies Record<string, PluginPermission>;
export type PluginMethodName = keyof typeof PLUGIN_METHODS;

export const PLUGIN_LIMITS = {
  /** Longest id of a plugin, in characters. */
  idChars: 32,
  /** Longest name of a plugin, in characters. */
  nameChars: 64,
  /** Longest version text, in characters. */
  versionChars: 32,
  /** Longest `main` path, in characters. */
  mainChars: 256,
  /** Longest id of a request, in characters (when it is text). */
  requestIdChars: 64,
  /** Longest id of a palette action, in characters. */
  actionIdChars: 64,
  /** Longest label of a palette action or title of a panel, in characters. */
  labelChars: 80,
  /** Most palette actions one plugin may hold. */
  actions: 64,
} as const;

const hasControl = (text: string): boolean => /\p{Cc}/u.test(text);

/** Whether `main` stays inside the folder of the plugin: relative, no `..`, no drive, no control. */
function isInsidePath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  if (hasControl(path)) return false;
  return !path.split(/[\\/]/).some((part) => part === "..");
}

const pluginTextSchema = (name: string, max: number) =>
  z
    .string({ error: `${name} must be text` })
    .trim()
    .min(1, { error: `${name} must not be empty` })
    .max(max, { error: `${name} is longer than ${max} characters` })
    .refine((text) => !hasControl(text), { error: `${name} must not have control characters` });

/** The `plugin.json` of a plugin. Fields that are not listed here are errors, not ignored. */
export const pluginManifestSchema = z.strictObject({
  id: z
    .string({ error: "id must be text" })
    .regex(/^[a-z0-9-]+$/, { error: "id may only have the characters a-z, 0-9 and -" })
    .max(PLUGIN_LIMITS.idChars, { error: `id is longer than ${PLUGIN_LIMITS.idChars} characters` }),
  name: pluginTextSchema("name", PLUGIN_LIMITS.nameChars),
  version: z
    .string({ error: "version must be text" })
    .regex(/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/, {
      error: "version must look like 1.2.3",
    })
    .max(PLUGIN_LIMITS.versionChars, {
      error: `version is longer than ${PLUGIN_LIMITS.versionChars} characters`,
    }),
  apiVersion: z.literal(PLUGIN_API_VERSION, {
    error: `apiVersion must be ${PLUGIN_API_VERSION}, the only version of the API there is`,
  }),
  main: z
    .string({ error: "main must be text" })
    .min(1, { error: "main must not be empty" })
    .max(PLUGIN_LIMITS.mainChars, {
      error: `main is longer than ${PLUGIN_LIMITS.mainChars} characters`,
    })
    .refine(isInsidePath, {
      error: "main must be a path inside the folder of the plugin (relative, no .., no drive)",
    }),
  permissions: z
    .array(
      z.enum(PLUGIN_PERMISSIONS, {
        error: `a permission must be one of ${PLUGIN_PERMISSIONS.join(", ")}`,
      }),
      { error: "permissions must be a list" },
    )
    .superRefine((list, ctx) => {
      const seen = new Set<string>();
      list.forEach((permission, index) => {
        if (seen.has(permission)) {
          ctx.addIssue({
            code: "custom",
            path: [index],
            message: `permission ${permission} is listed twice`,
          });
        }
        seen.add(permission);
      });
    }),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export type PluginManifestResult =
  { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] };

/** Checks the parsed content of a `plugin.json`. Never throws; the errors say which field. */
export function parsePluginManifest(value: unknown): PluginManifestResult {
  const parsed = pluginManifestSchema.safeParse(value);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    ),
  };
}

/** Why a request got no result: the codes of the local API, plus the one this layer adds. */
export type PluginErrorCode = ApiErrorCode | "permission_denied";

export interface PluginError {
  code: PluginErrorCode;
  /** A sentence for the plugin's author. */
  message: string;
  /** With `permission_denied`: the permission the manifest does not hold. */
  permission?: PluginPermission;
}

/** The id a request carries and its answer repeats: text, or a whole number. */
export type PluginRequestId = string | number;

/** A request of a plugin, protocol v1. `params` is whatever the method takes. */
export interface PluginRequest {
  version: typeof PLUGIN_API_VERSION;
  id: PluginRequestId;
  method: string;
  params?: unknown;
}

/** The answer to a request: the same `id` (`null` when the request had no usable one) and a `result` or an `error`, never both. */
export type PluginResponse =
  | { version: typeof PLUGIN_API_VERSION; id: PluginRequestId | null; result: ApiJson }
  | { version: typeof PLUGIN_API_VERSION; id: PluginRequestId | null; error: PluginError };

/** An action a plugin put in the palette. The host shows it and, when chosen, tells the plugin. */
export interface PluginPaletteAction {
  /** Unique within the plugin. */
  id: string;
  label: string;
}

/** The panel a plugin asked to open. */
export interface PluginPanelRequest {
  title: string;
}

/** What a plugin asked the app to show: the host reads it, the plugin cannot. */
export interface PluginRegistry {
  actions(): readonly PluginPaletteAction[];
  /** The panel last asked for; `null` when none was. */
  panel(): PluginPanelRequest | null;
}

/** The broker of one plugin. */
export interface PluginBroker {
  readonly manifest: PluginManifest;
  readonly registry: PluginRegistry;
  /** Answers one request. Never throws and never rejects. */
  handle(request: unknown): Promise<PluginResponse>;
}

const answerError = (
  id: PluginRequestId | null,
  code: PluginErrorCode,
  message: string,
  permission?: PluginPermission,
): PluginResponse => ({
  version: PLUGIN_API_VERSION,
  id,
  error: { code, message, ...(permission !== undefined ? { permission } : {}) },
});

const answerResult = (id: PluginRequestId, result: ApiJson): PluginResponse => ({
  version: PLUGIN_API_VERSION,
  id,
  result,
});

/** A text from the plugin, cut and made single line so it can sit in a message. */
function shorten(text: string): string {
  const chars = [...text];
  const out = chars
    .slice(0, 40)
    .map((c) => (/\p{Cc}/u.test(c) ? "?" : c))
    .join("");
  return `"${out}${chars.length > 40 ? "..." : ""}"`;
}

function readId(value: unknown): PluginRequestId | null {
  if (typeof value === "string") {
    const length = [...value].length;
    return length >= 1 && length <= PLUGIN_LIMITS.requestIdChars ? value : null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  return null;
}

const actionParams = z.strictObject({
  id: z
    .string({ error: "id must be text" })
    .regex(/^[a-z0-9._-]+$/, { error: "id may only have the characters a-z, 0-9, . _ and -" })
    .max(PLUGIN_LIMITS.actionIdChars, {
      error: `id is longer than ${PLUGIN_LIMITS.actionIdChars} characters`,
    }),
  label: pluginTextSchema("label", PLUGIN_LIMITS.labelChars),
});

const panelParams = z.strictObject({ title: pluginTextSchema("title", PLUGIN_LIMITS.labelChars) });

function problemOf(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "the parameters do not fit the method";
  if (issue.code === "unrecognized_keys") {
    return `unknown parameter ${shorten(issue.keys[0] ?? "")}`;
  }
  return issue.path.length > 0 ? `"${issue.path.join(".")}": ${issue.message}` : issue.message;
}

const fromApi = (id: PluginRequestId, outcome: Awaited<ReturnType<typeof dispatchApiCall>>) =>
  "error" in outcome
    ? answerError(id, outcome.error.code, outcome.error.message)
    : answerResult(id, outcome.result);

class Registry implements PluginRegistry {
  readonly #actions: PluginPaletteAction[] = [];
  #panel: PluginPanelRequest | null = null;

  actions(): readonly PluginPaletteAction[] {
    return this.#actions.map((action) => ({ ...action }));
  }

  panel(): PluginPanelRequest | null {
    return this.#panel === null ? null : { ...this.#panel };
  }

  /** Puts the action in; an id already there takes the new label and keeps its place. */
  register(action: PluginPaletteAction): boolean {
    const at = this.#actions.findIndex((held) => held.id === action.id);
    if (at >= 0) {
      this.#actions[at] = { ...action };
      return true;
    }
    if (this.#actions.length >= PLUGIN_LIMITS.actions) return false;
    this.#actions.push({ ...action });
    return true;
  }

  open(panel: PluginPanelRequest): void {
    this.#panel = { ...panel };
  }
}

/**
 * The broker of one plugin: `handle(request)` checks the request in this order and stops at the
 * first problem: it must be an object with a usable `id` and no field but `version`, `id`,
 * `method` and `params` (`invalid_request`; a `version` other than 1 is `unsupported_version`
 * before the other fields are looked at, since a later version may carry more); the method must be
 * one of `PLUGIN_METHODS` (`unknown_method`); the manifest must hold the permission of the method
 * (`permission_denied`, nothing else is touched); the parameters must fit (`invalid_params`). Then
 * it acts: `terminal.read` and `tabs.create` become `terminal.read` and `items.create` of
 * `dispatchApiCall` over `host`; `palette.register` and `panel.open` are written to the registry.
 */
export function createPluginBroker(manifest: PluginManifest, host: ApiHost): PluginBroker {
  const registry = new Registry();

  async function act(
    id: PluginRequestId,
    method: PluginMethodName,
    params: unknown,
  ): Promise<PluginResponse> {
    switch (method) {
      case "terminal.read":
      case "tabs.create": {
        // The params go on as they came: `dispatchApiCall` checks them again and refuses any field
        // it does not know, so a plugin cannot reach a parameter the API does not give it.
        const call = {
          method: method === "tabs.create" ? "items.create" : "terminal.read",
          params: params ?? {},
        } as ApiCall;
        return fromApi(id, await dispatchApiCall(call, host));
      }
      case "palette.register": {
        const parsed = actionParams.safeParse(params);
        if (!parsed.success) return answerError(id, "invalid_params", problemOf(parsed.error));
        if (!registry.register(parsed.data)) {
          return answerError(
            id,
            "failed",
            `a plugin may hold up to ${PLUGIN_LIMITS.actions} palette actions`,
          );
        }
        return answerResult(id, { id: parsed.data.id });
      }
      case "panel.open": {
        const parsed = panelParams.safeParse(params);
        if (!parsed.success) return answerError(id, "invalid_params", problemOf(parsed.error));
        registry.open(parsed.data);
        return answerResult(id, { title: parsed.data.title });
      }
    }
  }

  async function handle(request: unknown): Promise<PluginResponse> {
    try {
      if (typeof request !== "object" || request === null || Array.isArray(request)) {
        return answerError(null, "invalid_request", "the request must be an object");
      }
      const { version, id: rawId, method, params, ...rest } = request as Record<string, unknown>;
      const id = readId(rawId);
      if (id === null) {
        return answerError(
          null,
          "invalid_request",
          `"id" must be text of 1 to ${PLUGIN_LIMITS.requestIdChars} characters or a whole number`,
        );
      }
      if (version !== PLUGIN_API_VERSION) {
        const said = typeof version === "number" ? String(version) : "none";
        return answerError(
          id,
          "unsupported_version",
          `this build speaks version ${PLUGIN_API_VERSION} of the plugin API, the request said ${said}`,
        );
      }
      const [extra] = Object.keys(rest);
      if (extra !== undefined) {
        return answerError(id, "invalid_request", `unknown field ${shorten(extra)}`);
      }
      if (typeof method !== "string") {
        return answerError(id, "invalid_request", '"method" must be text');
      }
      if (!Object.hasOwn(PLUGIN_METHODS, method)) {
        return answerError(id, "unknown_method", `unknown method ${shorten(method)}`);
      }
      const known = method as PluginMethodName;
      const needed: PluginPermission = PLUGIN_METHODS[known];
      if (!manifest.permissions.includes(needed)) {
        return answerError(
          id,
          "permission_denied",
          `${known} needs the permission ${needed}, which the manifest of ${manifest.id} does not hold`,
          needed,
        );
      }
      return await act(id, known, params);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return answerError(readIdOf(request), "internal", `the request broke: ${reason}`);
    }
  }

  return { manifest, registry, handle };
}

/** The id of a request that broke the broker, when it can still be read. */
function readIdOf(request: unknown): PluginRequestId | null {
  try {
    return typeof request === "object" && request !== null
      ? readId((request as Record<string, unknown>)["id"])
      : null;
  } catch {
    return null;
  }
}
