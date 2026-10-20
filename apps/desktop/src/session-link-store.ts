import { useSyncExternalStore } from "react";
import { layoutPanes } from "@noren/model";
import type { Backend, Item, Pane, SessionId, SessionLink } from "@noren/model";

// Where the connection of each session to its shell stands, for the sessions of an SSH profile
// (`Backend.onSessionLink`). A session starts connected and the backend tells only when that
// changes, so the store keeps what is not connected: a session with no entry is connected (or is a
// shell on this machine, which never has a connection to lose). A session that ends is forgotten.
// The views read it per pane (`linkOfPane`) and render again when it changes; the state lives only
// as long as the window, since a connection is a fact about now.

const links = new Map<SessionId, SessionLink>();
const listeners = new Set<() => void>();
/** Moves when an entry changed, so a view knows to ask again. */
let version = 0;

function notify(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

const sameLink = (a: SessionLink, b: SessionLink): boolean =>
  a.state === b.state &&
  a.attempt === b.attempt &&
  a.maxAttempts === b.maxAttempts &&
  a.retryInMs === b.retryInMs &&
  a.reason === b.reason;

/** `onChange` runs when `linkOfSession` may answer something else. Returns the function that stops it. */
export function subscribeSessionLinks(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Takes what the backend told: `connected` clears the entry, the other states replace it. */
export function applySessionLink(link: SessionLink): void {
  if (link.state === "connected") {
    if (links.delete(link.id)) notify();
    return;
  }
  const before = links.get(link.id);
  if (before !== undefined && sameLink(before, link)) return;
  links.set(link.id, { ...link });
  notify();
}

/** The session ended (or was closed): nothing more to say about its connection. */
export function forgetSessionLink(id: SessionId): void {
  if (links.delete(id)) notify();
}

/** The connection of a session while it is not up; `undefined` when it is up or has none to lose. */
export function linkOfSession(id: SessionId): SessionLink | undefined {
  return links.get(id);
}

/** The connection of the shell of a pane, `undefined` when it is up, has none or the pane has no shell yet. */
export function linkOfPane(pane: Pane): SessionLink | undefined {
  return pane.sessionId === undefined ? undefined : links.get(Number(pane.sessionId));
}

/** `linkOfPane` for a component: it renders again when a connection changes. */
export function useLinkOfPane(): (pane: Pane) => SessionLink | undefined {
  useSyncExternalStore(subscribeSessionLinks, () => version);
  return linkOfPane;
}

/** The sessions of the panes of a tab whose connection gave up. */
export function failedSessionsOf(item: Item): SessionId[] {
  return layoutPanes(item.layout).flatMap((pane) => {
    const link = linkOfPane(pane);
    return link?.state === "failed" ? [Number(pane.sessionId)] : [];
  });
}

/**
 * Try again on a tab: asks the backend to connect once more every session of the tab that gave up.
 * A call that is refused (the session ended meanwhile) changes nothing here: the state that follows
 * comes from `onSessionLink`, not from this call. Resolves when every call has settled.
 */
export async function retryFailedLinks(
  backend: Pick<Backend, "retrySession">,
  item: Item,
): Promise<void> {
  await Promise.all(
    failedSessionsOf(item).map((id) => backend.retrySession(id).catch(() => undefined)),
  );
}

/**
 * Follows the backend: every change of a connection is kept, every session that ends is forgotten.
 * Returns the function that stops following.
 */
export function startSessionLinks(backend: Pick<Backend, "onSessionLink" | "onExit">): () => void {
  const stopLinks = backend.onSessionLink(applySessionLink);
  const stopExits = backend.onExit((exit) => forgetSessionLink(exit.id));
  return () => {
    stopLinks();
    stopExits();
  };
}

/** Forgets every connection, so a test starts from nothing. */
export function resetSessionLinks(): void {
  links.clear();
  notify();
}
