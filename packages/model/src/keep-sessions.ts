/**
 * `sessions.keepOnClose` when the settings file does not say: closing the window leaves the shells of
 * the panes running (in the session daemon) and opening the app again gives each pane its shell back.
 */
export const DEFAULT_KEEP_SESSIONS = true;

/**
 * Whether the shells of the panes outlive the app, from the `sessions` section of the settings: they
 * do unless `sessions.keepOnClose` is `false`. The one place that decides it, for the interface (which
 * hands the answer to the backend) and the tests.
 */
export function keepSessionsAllowed(
  sessions: { keepOnClose?: boolean | undefined } | undefined,
): boolean {
  return sessions?.keepOnClose ?? DEFAULT_KEEP_SESSIONS;
}
