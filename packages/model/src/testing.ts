// Test-only entry point (`@noren/model/testing`). Kept apart from `index.ts` so `fast-check`,
// a dev dependency, never ends up in the app bundle.
export { arbWorkspace } from "./arbitraries";
export type { WorkspaceArbitraryOptions } from "./arbitraries";
