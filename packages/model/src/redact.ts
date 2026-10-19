// Redaction of secrets: what runs over every piece of text before it can go to an AI provider. A
// secret is swapped for a marker (`[REDACTED:jwt]`), so the person reading the preview and the model
// both see that something was there and what kind of thing it was. Pure; it never throws. It errs on
// the side of hiding: a harmless value now and then is taken out, a secret that is recognised never
// stays.

/** What a secret was recognised as. */
export const REDACTION_KINDS = [
  "pem-private-key",
  "aws-access-key",
  "github-token",
  "sk-key",
  "stripe-key",
  "google-api-key",
  "jwt",
  "slack-token",
  "url-password",
  "authorization",
  "bearer-token",
  "password",
  "token",
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

/** What `redactSecrets` found. */
export interface Redaction {
  /** The text with every secret swapped for its marker. */
  text: string;
  /** How many secrets were swapped. */
  count: number;
  /** The kinds that were found, once each, in the order they first appear in the text. */
  kinds: RedactionKind[];
}

/** The marker that takes the place of a secret of `kind`. */
export function redactionMarker(kind: RedactionKind): string {
  return `[REDACTED:${kind}]`;
}

/** What every marker starts with: a value that starts with it is already redacted. */
const MARKER_START = "[REDACTED:";

interface Rule {
  kind: RedactionKind;
  /**
   * Global, with the `d` flag. What is swapped is the first capture group that took part, or the
   * whole match when the pattern has none: `password=` stays and only the value goes.
   */
  pattern: RegExp;
}

// A value after `key=` or `key:`: quoted (the quotes stay out of it) or a run without blanks or
// separators. The three alternatives are three capture groups; only one takes part.
const VALUE = String.raw`(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"',;&]+))`;
// The same, for the form `key: value`, which is also how prose is written, so it takes less: a
// quoted value of four characters or more, or a run of eight or more that has a digit in it.
const COLON_VALUE = String.raw`(?:"([^"\r\n]{4,})"|'([^'\r\n]{4,})'|((?=[^\s"',;&]*[0-9])[^\s"',;&]{8,}))`;
// A key stands at a start: nothing alphanumeric before it (an underscore may be, as in `DB_PASSWORD`).
const KEY_START = String.raw`(?<![A-Za-z0-9])`;
const AFTER_KEY = String.raw`["']?[ \t]*`;
const TOKEN_KEYS = String.raw`(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?access[_-]?key|secret[_-]?key|client[_-]?secret|secret|token)`;
const SCHEMES = "Bearer|Basic|Token|Digest|Negotiate|NTLM";

// More specific rules first: when two find the same stretch, the first one names it.
const RULES: readonly Rule[] = [
  {
    kind: "pem-private-key",
    // An unfinished block (its end was cut off) goes to the end of the text.
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/dg,
  },
  {
    kind: "aws-access-key",
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/dg,
  },
  {
    kind: "github-token",
    pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/dg,
  },
  {
    // `sk-` and `sk-ant-`, as long as a key is: 20 characters or more with a digit among them. A word
    // such as `sk-learn` or `risk-free` is not one.
    kind: "sk-key",
    pattern: /(?<![A-Za-z0-9])sk-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}/dg,
  },
  {
    kind: "stripe-key",
    pattern: /(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/dg,
  },
  {
    kind: "google-api-key",
    pattern: /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}/dg,
  },
  {
    kind: "jwt",
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/dg,
  },
  {
    kind: "slack-token",
    pattern: /(?<![A-Za-z0-9])(?:xox[abposr]-|xapp-\d-)[A-Za-z0-9-]{10,}/dg,
  },
  {
    // `scheme://user:password@host`: the password goes, the user and the host stay.
    kind: "url-password",
    pattern: /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/]+)@/dg,
  },
  {
    // `Authorization: Bearer <token>`, `Basic <base64>` and the like, in a header, a curl line or a JSON object.
    kind: "authorization",
    pattern: new RegExp(
      String.raw`Authorization${AFTER_KEY}[:=][ \t]*["']?(?:${SCHEMES})[ \t]+([^\s"',;]{6,})`,
      "dgi",
    ),
  },
  {
    // `Authorization: <credentials>` with no scheme: only a value long enough to be one.
    kind: "authorization",
    pattern: new RegExp(
      String.raw`Authorization${AFTER_KEY}[:=][ \t]*["']?(?!(?:${SCHEMES})[ \t])([^\s"',;]{20,})`,
      "dgi",
    ),
  },
  {
    kind: "bearer-token",
    pattern: /\bBearer[ \t]+((?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{20,})/dg,
  },
  {
    kind: "password",
    pattern: new RegExp(
      String.raw`${KEY_START}(?:password|passwd|passphrase)${AFTER_KEY}[=:][ \t]*${VALUE}`,
      "dgi",
    ),
  },
  {
    // `senha` is a word of everyday Portuguese, so only `senha=` counts, never `senha:`.
    kind: "password",
    pattern: new RegExp(String.raw`${KEY_START}senha${AFTER_KEY}=[ \t]*${VALUE}`, "dgi"),
  },
  {
    kind: "token",
    pattern: new RegExp(String.raw`${KEY_START}${TOKEN_KEYS}${AFTER_KEY}=[ \t]*${VALUE}`, "dgi"),
  },
  {
    kind: "token",
    pattern: new RegExp(
      String.raw`${KEY_START}${TOKEN_KEYS}${AFTER_KEY}:[ \t]*${COLON_VALUE}`,
      "dgi",
    ),
  },
];

/** A value that holds no secret: a reference to a variable, a `<placeholder>`, a mask, or a marker already there. */
const PLACEHOLDER = /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>\r\n]*>|\*+)$/;

interface Span {
  start: number;
  end: number;
  rule: number;
}

/** The stretch of a match that is the secret: its first capture group that took part, or all of it. */
function secretOf(match: RegExpMatchArray): [number, number] | undefined {
  const indices = match.indices;
  if (indices === undefined) return undefined;
  for (let group = 1; group < indices.length; group++) {
    const found = indices[group];
    if (found !== undefined) return [found[0], found[1]];
  }
  const whole = indices[0];
  return whole === undefined ? undefined : [whole[0], whole[1]];
}

/**
 * Swaps the secrets in `text` for markers and says how many it swapped. Recognised: private keys
 * in PEM form, AWS access keys (`AKIA`, `ASIA`), GitHub tokens (`ghp_` and kin, `github_pat_`),
 * keys that start with `sk-` (OpenAI, `sk-ant-`) and Stripe keys, Google API keys, JWTs, chat
 * tokens (`xox`), the password in a URL (`user:pass@host`), `Authorization` headers and bare
 * `Bearer` tokens, the value of `password=` and of `token=`, `api_key=`, `secret=` and the like.
 * Redacting a text that was redacted swaps nothing more.
 */
export function redactSecrets(text: string): Redaction {
  const spans: Span[] = [];
  RULES.forEach((rule, index) => {
    for (const match of text.matchAll(rule.pattern)) {
      const range = secretOf(match);
      if (range === undefined || range[0] === range[1]) continue;
      const value = text.slice(range[0], range[1]);
      if (value.startsWith(MARKER_START) || PLACEHOLDER.test(value)) continue;
      spans.push({ start: range[0], end: range[1], rule: index });
    }
  });
  // Left to right; where two overlap, the longer one wins, and then the rule listed first.
  spans.sort((a, b) => a.start - b.start || b.end - a.end || a.rule - b.rule);

  let out = "";
  let cursor = 0;
  let count = 0;
  const kinds: RedactionKind[] = [];
  for (const span of spans) {
    if (span.start < cursor) continue;
    const kind = RULES[span.rule]?.kind;
    if (kind === undefined) continue;
    out += text.slice(cursor, span.start) + redactionMarker(kind);
    cursor = span.end;
    count++;
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return { text: out + text.slice(cursor), count, kinds };
}
