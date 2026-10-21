import { useSyncExternalStore } from "react";
import { checkPluginFolders, createPluginBroker } from "@noren/model";
import type { ApiHost, Backend, PluginBroker, PluginResponse } from "@noren/model";

// The host of the plugins (NOR-F18-01c): every plugin the folder `plugins/` holds and that
// `checkPluginFolders` accepts runs in a Worker of its own, tied to the broker of that plugin
// (`createPluginBroker`, the permissions of the manifest). What the Worker posts is handed to
// `broker.handle` and the answer is posted back; the Worker has no other way to reach the app. The
// actions a plugin puts in the palette are read from the registry of its broker, and choosing one
// posts `{ event: "action", id }` to that plugin.
//
// The Worker is made from a `blob:` address that holds the text of `main`, so it needs nothing from
// the disk and no address of the app. It is a classic Worker created from the page, so it keeps the
// policy of the page: `script-src 'self'` stops `eval` and `importScripts` of anything outside, and
// `connect-src` stops the network. Nothing of Tauri is passed to it (no bridge, no `invoke`): its
// whole power is the messages. A plugin that is invalid, or whose Worker fails, is only recorded
// (`status()`), never an error dialog and never a reason for the others to stop.
// docs/SECURITY_REVIEW.md, section 1, tells why `worker-src blob:` is in the policy.
//
// The panel (NOR-F18-01d): when a plugin that holds the permission `panel` opens one (`panel.open`
// answered with a result), the host remembers the title and the HTML text the broker wrote to the
// registry, and `PluginPanel` shows it in a frame with no power. One panel at a time: the last one
// opened. The person closes it (`closePanel`); it also closes when its plugin fails or stops, so a
// plugin that dies never leaves a panel behind.

/** The part of a Worker the host uses; a test hands in a stand-in with the same shape. */
export interface PluginWorker {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { preventDefault?(): void; message?: string }) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
}

/** Makes the Worker that runs `source` (the text of a plugin's main file), named after the plugin. */
export type PluginWorkerFactory = (source: string, name: string) => PluginWorker;

/** The real factory: a Worker from a `blob:` address of the text, revoked once the Worker spoke or ended. */
export const blobWorkerFactory: PluginWorkerFactory = (source, name) => {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  let revoked = false;
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    URL.revokeObjectURL(url);
  };
  let worker: Worker;
  try {
    worker = new Worker(url, { name });
  } catch (e) {
    revoke();
    throw e;
  }
  const plugin: PluginWorker = {
    postMessage: (message) => worker.postMessage(message),
    terminate: () => {
      revoke();
      worker.terminate();
    },
    onmessage: null,
    onerror: null,
    onmessageerror: null,
  };
  worker.onmessage = (event: MessageEvent) => {
    revoke();
    plugin.onmessage?.({ data: event.data });
  };
  worker.onerror = (event: ErrorEvent) => {
    revoke();
    plugin.onerror?.(event);
  };
  worker.onmessageerror = (event: MessageEvent) => plugin.onmessageerror?.(event);
  return plugin;
};

/** What the host knows of one folder of `plugins/`. */
export type PluginStatus =
  | { folder: string; state: "running"; id: string; name: string }
  | { folder: string; state: "failed"; id: string; name: string; reason: string }
  | { folder: string; state: "invalid"; reason: string };

/** An action a running plugin put in the palette. */
export interface PluginActionView {
  pluginId: string;
  pluginName: string;
  actionId: string;
  label: string;
}

/** The panel on screen: whose it is, its title and the HTML text of its content. */
export interface PluginPanelView {
  pluginId: string;
  pluginName: string;
  title: string;
  html: string;
}

/** One message between the host and a plugin, kept for the test hook (`observe`). */
export interface PluginTraffic {
  pluginId: string;
  /** `from-plugin`: what the Worker posted; `to-plugin`: what the host posted to it. */
  direction: "from-plugin" | "to-plugin";
  message: unknown;
}

export interface PluginHostOptions {
  backend: Pick<Backend, "listPlugins">;
  /** What the brokers act on (the workspace and the shells of the app). */
  apiHost: ApiHost;
  /** Defaults to `blobWorkerFactory`. */
  createWorker?: PluginWorkerFactory;
  /** Sees every message in both directions; only tests give it. */
  observe?: (traffic: PluginTraffic) => void;
}

interface Running {
  folder: string;
  id: string;
  name: string;
  broker: PluginBroker;
  worker: PluginWorker;
}

/** Whether the message is a request for `panel.open` (the broker has the last word on it). */
const isPanelOpen = (message: unknown): boolean =>
  typeof message === "object" &&
  message !== null &&
  (message as Record<string, unknown>)["method"] === "panel.open";

const sentence = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Runs the plugins and keeps what the palette needs from them. */
export class PluginHost {
  readonly #options: PluginHostOptions;
  readonly #listeners = new Set<() => void>();
  readonly #running = new Map<string, Running>();
  #statuses: PluginStatus[] = [];
  #panel: PluginPanelView | null = null;
  #version = 0;
  #actionsKey = "";
  #started = false;

  constructor(options: PluginHostOptions) {
    this.#options = options;
  }

  /**
   * Lists the folder and runs each valid plugin. Runs once: a second call does nothing. Never
   * rejects; a folder that cannot be read leaves the app without plugins.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    let check: ReturnType<typeof checkPluginFolders>;
    try {
      check = checkPluginFolders(await this.#options.backend.listPlugins());
    } catch {
      return;
    }
    const rejected = check.invalid.map((plugin): PluginStatus => ({
      folder: plugin.folder,
      state: "invalid",
      reason: plugin.reason,
    }));
    this.#statuses = [...rejected];
    for (const plugin of check.valid) this.#run(plugin.folder, plugin.manifest, plugin.main);
    this.#changed();
  }

  /** One status per folder: running, failed or invalid (with the reason). */
  status(): readonly PluginStatus[] {
    return this.#statuses.map((status) => ({ ...status }));
  }

  /** The actions of the plugins that run, in the order the folders came and the plugins registered them. */
  actions(): PluginActionView[] {
    const views: PluginActionView[] = [];
    for (const plugin of this.#running.values()) {
      for (const action of plugin.broker.registry.actions()) {
        views.push({
          pluginId: plugin.id,
          pluginName: plugin.name,
          actionId: action.id,
          label: action.label,
        });
      }
    }
    return views;
  }

  /** The panel on screen, or `null` when none is. */
  panel(): PluginPanelView | null {
    return this.#panel === null ? null : { ...this.#panel };
  }

  /** Takes the panel off the screen. The plugin is not told; it can open another one. */
  closePanel(): void {
    if (this.#panel === null) return;
    this.#panel = null;
    this.#changed();
  }

  /** Tells the plugin that the action was chosen. An unknown plugin or action does nothing. */
  choose(pluginId: string, actionId: string): void {
    const plugin = this.#running.get(pluginId);
    if (plugin === undefined) return;
    if (!plugin.broker.registry.actions().some((action) => action.id === actionId)) return;
    this.#post(plugin, { event: "action", id: actionId });
  }

  /** A number that changes whenever the status or the actions of any plugin change. */
  version(): number {
    return this.#version;
  }

  /** Calls `listener` whenever the version changes. Returns the way to stop. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Ends every Worker. */
  stop(): void {
    for (const plugin of this.#running.values()) this.#end(plugin);
    this.#running.clear();
    this.#panel = null;
  }

  #run(folder: string, manifest: Parameters<typeof createPluginBroker>[0], main: string): void {
    const { id, name } = manifest;
    try {
      const worker = (this.#options.createWorker ?? blobWorkerFactory)(main, id);
      const broker = createPluginBroker(manifest, this.#options.apiHost);
      const plugin: Running = { folder, id, name, broker, worker };
      this.#running.set(id, plugin);
      this.#statuses.push({ folder, state: "running", id, name });
      worker.onmessage = (event) => {
        void this.#serve(plugin, event.data);
      };
      worker.onerror = (event) => {
        // The error is told in the status, not in the console of every start.
        event.preventDefault?.();
        this.#fail(plugin, event.message ?? "the plugin raised an error");
      };
      worker.onmessageerror = () =>
        this.#fail(plugin, "the plugin sent a message that cannot be read");
    } catch (e) {
      this.#statuses.push({ folder, state: "failed", id, name, reason: sentence(e) });
    }
  }

  async #serve(plugin: Running, message: unknown): Promise<void> {
    if (this.#running.get(plugin.id) !== plugin) return;
    this.#options.observe?.({ pluginId: plugin.id, direction: "from-plugin", message });
    const response: PluginResponse = await plugin.broker.handle(message);
    if (this.#running.get(plugin.id) !== plugin) return;
    // A panel is shown only when the broker said yes to the request (a plugin without the
    // permission `panel` got `permission_denied` and nothing was written to its registry).
    if (isPanelOpen(message) && "result" in response) {
      const asked = plugin.broker.registry.panel();
      if (asked !== null) {
        this.#panel = {
          pluginId: plugin.id,
          pluginName: plugin.name,
          title: asked.title,
          html: asked.html,
        };
      }
    }
    this.#post(plugin, response);
    this.#changed();
  }

  #post(plugin: Running, message: unknown): void {
    this.#options.observe?.({ pluginId: plugin.id, direction: "to-plugin", message });
    try {
      plugin.worker.postMessage(message);
    } catch (e) {
      this.#fail(plugin, sentence(e));
    }
  }

  #fail(plugin: Running, reason: string): void {
    if (this.#running.get(plugin.id) !== plugin) return;
    this.#running.delete(plugin.id);
    this.#end(plugin);
    if (this.#panel?.pluginId === plugin.id) this.#panel = null;
    const at = this.#statuses.findIndex((status) => status.folder === plugin.folder);
    const failed: PluginStatus = {
      folder: plugin.folder,
      state: "failed",
      id: plugin.id,
      name: plugin.name,
      reason,
    };
    if (at >= 0) this.#statuses[at] = failed;
    else this.#statuses.push(failed);
    this.#changed();
  }

  #end(plugin: Running): void {
    plugin.worker.onmessage = null;
    plugin.worker.onerror = null;
    plugin.worker.onmessageerror = null;
    try {
      plugin.worker.terminate();
    } catch {
      // A Worker that cannot be ended is already gone.
    }
  }

  /** The broker's registry does not tell when it changes: the host looks after each answer. */
  #changed(): void {
    const key = JSON.stringify([this.#statuses, this.actions(), this.#panel]);
    if (key === this.#actionsKey) return;
    this.#actionsKey = key;
    this.#version += 1;
    for (const listener of [...this.#listeners]) listener();
  }
}

/** The most messages `pluginTrafficLog` keeps. */
const TRAFFIC_LOG_LIMIT = 200;

/**
 * What the plugins and the host said to each other, newest last. Only the web build fills it (the
 * test hook shows it, so a test can see the answer a plugin got); the app in a window keeps none.
 */
export const pluginTrafficLog: PluginTraffic[] = [];

/** `observe` of a host that fills `pluginTrafficLog`. */
export function recordPluginTraffic(traffic: PluginTraffic): void {
  pluginTrafficLog.push(traffic);
  if (pluginTrafficLog.length > TRAFFIC_LOG_LIMIT) pluginTrafficLog.shift();
}

let current: PluginHost | undefined;

/** The host that runs, for the palette and the test hook; `undefined` before it started. */
export function currentPluginHost(): PluginHost | undefined {
  return current;
}

/** Starts the host (once per page: a second call returns the one that runs). */
export function startPlugins(options: PluginHostOptions): PluginHost {
  if (current !== undefined) return current;
  const host = new PluginHost(options);
  current = host;
  void host.start();
  return host;
}

const noActions: PluginActionView[] = [];
let lastVersion = -1;
let lastActions: PluginActionView[] = noActions;

/** The actions of the plugins now; the same array while nothing changed (for `useSyncExternalStore`). */
function snapshot(): PluginActionView[] {
  const host = current;
  if (host === undefined) return noActions;
  if (host.version() !== lastVersion) {
    lastVersion = host.version();
    lastActions = host.actions();
  }
  return lastActions;
}

function subscribe(listener: () => void): () => void {
  // The host starts at boot, before the interface is drawn, so it is there to follow.
  return current?.subscribe(listener) ?? (() => undefined);
}

/** The palette actions of the running plugins; draws again whenever they change. */
export function usePluginActions(): readonly PluginActionView[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

let lastPanelVersion = -1;
let lastPanel: PluginPanelView | null = null;

function panelSnapshot(): PluginPanelView | null {
  const host = current;
  if (host === undefined) return null;
  if (host.version() !== lastPanelVersion) {
    lastPanelVersion = host.version();
    lastPanel = host.panel();
  }
  return lastPanel;
}

/** The panel a plugin opened, or `null`; draws again whenever it opens or closes. */
export function usePluginPanel(): PluginPanelView | null {
  return useSyncExternalStore(subscribe, panelSnapshot, panelSnapshot);
}
