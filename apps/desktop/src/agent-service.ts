import { agentSettingsOf } from "@noren/model";
import type { Backend } from "@noren/model";
import { AgentScanner } from "./agent-scanner";
import { setTreeAgents } from "./agent-store";
import { configManager } from "./config-store";
import { realClock } from "./real-clock";
import type { WorkspaceStore } from "./workspace-store";

// The look at the process tree while the app runs: the scanner (see `agent-scanner.ts`) asks the
// backend every few seconds (`agents.scanSeconds`) which pane has an agent under its shell and the
// store (`agent-store.ts`) keeps the answer for the tabs to draw. It runs on real timers, in the
// web mode too: the fake backend answers from what a test said with `setSessionAgent`.

let scanner: AgentScanner | undefined;

/** The scanner that is running, for tests and diagnostics. */
export function currentAgentScanner(): AgentScanner | undefined {
  return scanner;
}

export interface AgentServiceOptions {
  store: WorkspaceStore;
  backend: Backend;
  onError?(error: unknown): void;
}

/** Starts the looks. Starting again replaces the scanner that was running. */
export function startAgentScanner(options: AgentServiceOptions): AgentScanner {
  scanner?.stop();
  const { store } = options;
  const started = new AgentScanner({
    clock: realClock,
    backend: options.backend,
    workspace: () => store.getState().workspace,
    settings: () => agentSettingsOf(configManager.state.config.agents),
    onResult: setTreeAgents,
    // A look that failed (the backend refused the catalog, say) leaves the last answer as it was;
    // the next look tries again.
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });
  scanner = started;
  started.start();
  return started;
}
