import { browserUrlProblem } from "@noren/model";
import { t, tDynamic } from "./i18n";
import type { MessageKey } from "./i18n";

// What the address bar of a browser pane does with the text typed in it: the same check the model
// and the shell make (`browserUrlProblem`), and the reason in words the person reads.

/** The result of reading an address: the page to go to, or why the pane may not show it. */
export type AddressReading = { ok: true; url: string } | { ok: false; problem: string };

/** Reads what was typed: blanks around it do not count, and it has to be a page the pane may show. */
export function readAddress(text: string): AddressReading {
  const url = text.trim();
  const problem = browserUrlProblem(url);
  return problem === undefined ? { ok: true, url } : { ok: false, problem };
}

/**
 * The words the model uses for each reason, and the text of the interface that says it in the
 * language in force. A reason this does not know (the model grew a new one) is shown as it came.
 */
const PROBLEM_TEXTS: Readonly<Record<string, MessageKey>> = {
  "the link is empty or too long": "browser.problem.empty",
  "only http and https links can be opened": "browser.problem.scheme",
  "the link has a blank, a control character or a backslash": "browser.problem.characters",
  "the link has no host": "browser.problem.noHost",
  "the link has a user name or password before the host": "browser.problem.userinfo",
  "the address has an escaped host name": "browser.problem.escapedHost",
  "the address is one of the app's own": "browser.problem.appOwn",
};

/** A reason `browserUrlProblem` gave, in the language in force. */
export function addressProblemText(problem: string): string {
  const key = Object.hasOwn(PROBLEM_TEXTS, problem) ? PROBLEM_TEXTS[problem] : undefined;
  return key !== undefined ? tDynamic(key) : t("browser.problem.other", { reason: problem });
}

/** The host of a page, for the title of its pane; the whole address when it has no readable host. */
export function browserTitle(url: string | undefined): string {
  if (url === undefined) return t("browser.pane");
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
