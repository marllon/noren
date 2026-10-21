// Tells the Rust side what the agents are doing, for the local API (NOR-F17-01f). The tracker of
// each pane (`agent-state-store.ts`) says when a state changes; this turns that into the command
// `api_agent_state(sessionId, state)`, which the Rust side publishes as the event `agent.state` to the
// clients that subscribed. Only the window `main` is allowed the command, and only the app starts this.

import type { AgentState } from "@noren/model";
import type { AgentStateReporter } from "./agent-state-store";
import type { TauriBridge } from "./tauri-backend";

/** The command the page tells a state with: `api_agent_state(sessionId, state)`. */
export const API_AGENT_STATE_COMMAND = "api_agent_state";

/**
 * A reporter that calls the command when the state of a session is not the one it last told. A
 * session is taken to be idle until said otherwise (a tracker starts there), so the first `idle`
 * is not a change; a session that goes back to idle is forgotten, so nothing piles up. A failed
 * call is dropped: the app is closing, and nobody waits for a state.
 */
export function createAgentStateReporter(bridge: Pick<TauriBridge, "invoke">): AgentStateReporter {
  const told = new Map<string, AgentState>();
  return (sessionId, state) => {
    if ((told.get(sessionId) ?? "idle") === state) return;
    if (state === "idle") told.delete(sessionId);
    else told.set(sessionId, state);
    bridge.invoke(API_AGENT_STATE_COMMAND, { sessionId, state }).catch(() => undefined);
  };
}
