// The entry point of `noren://` links. The Rust side (NOR-F5-07b) hands every link it receives to
// `window.__norenHandleDeepLink(url)`; a link that arrives before the interface is up waits here and
// is applied once the shell registers its handler.

import type { DeepLinkHandler } from "./deep-link-handler";

declare global {
  interface Window {
    /** Applies a raw `noren://` link. Resolves when it was applied or refused with a notice. */
    __norenHandleDeepLink?: (url: unknown) => Promise<void>;
  }
}

/** Links kept while no handler is registered; a flood is dropped from the oldest. */
const MAX_WAITING = 8;

let current: DeepLinkHandler | undefined;
const waiting: string[] = [];

/** Applies the link now, or keeps it until a handler is registered. */
export async function handleDeepLink(url: unknown): Promise<void> {
  if (typeof url !== "string") return;
  if (current === undefined) {
    waiting.push(url);
    if (waiting.length > MAX_WAITING) waiting.shift();
    return;
  }
  await current(url);
}

/** Registers (or, with `undefined`, removes) the handler and applies the links that waited. */
export function setDeepLinkHandler(handler: DeepLinkHandler | undefined): void {
  current = handler;
  if (handler === undefined) return;
  for (const url of waiting.splice(0)) void handler(url);
}

if (typeof window !== "undefined") window.__norenHandleDeepLink = handleDeepLink;
