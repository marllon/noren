import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REDACTION_KINDS, redactSecrets, redactionMarker } from "./redact";
import type { RedactionKind } from "./redact";

// The secrets below are made up and built from pieces, so no line of this file looks like a real
// credential to a scanner (and none is one).

const rep = (chunk: string, times: number): string => chunk.repeat(times);

const AWS = "AK" + "IA" + "IOSFODNN7EXAMPLE";
const AWS_TEMP = "AS" + "IA" + "Y34FZKBOKMUTVV7A";
const GITHUB = "gh" + "p_" + rep("a1B2", 9);
const GITHUB_FINE = "github" + "_pat_" + rep("x9Y8", 6) + "_" + rep("q7W6", 10);
const SK = "s" + "k-" + "proj-" + rep("Ab12", 8);
const SK_ANT = "s" + "k-" + "ant-api03-" + rep("Zy98", 10);
const STRIPE = "s" + "k_" + "live_" + rep("4eC3", 6);
const GOOGLE = "AI" + "za" + "Sy" + rep("A1b2", 8) + "xyz";
const JWT =
  "ey" +
  "JhbGciOiJIUzI1NiJ9" +
  "." +
  "ey" +
  "JzdWIiOiIxMjM0NTY3ODkwIn0" +
  "." +
  "SflKxwRJSMeKKF2QT4fw";
const SLACK = "xo" + "xb-" + "123456789012-" + "abcdefABCDEF1234";
const PEM = [
  "-----BEGIN " + "RSA PRIVATE KEY-----",
  "MIIEpAIBAAKCAQEA1234567890abcdef",
  "ZmFrZWtleWZha2VrZXlmYWtla2V5",
  "-----END " + "RSA PRIVATE KEY-----",
].join("\n");

/** [name, kind, a line that holds the secret, the secret]: one row per pattern. */
const CASES: readonly [string, RedactionKind, string, string][] = [
  ["AWS access key", "aws-access-key", `aws_key is ${AWS} today`, AWS],
  ["AWS temporary key", "aws-access-key", `export K=${AWS_TEMP}`, AWS_TEMP],
  ["GitHub classic token", "github-token", `remote: ${GITHUB} rejected`, GITHUB],
  ["GitHub fine-grained token", "github-token", `use ${GITHUB_FINE} here`, GITHUB_FINE],
  ["sk- key", "sk-key", `OPENAI ${SK} done`, SK],
  ["sk-ant- key", "sk-key", `key: ${SK_ANT}`, SK_ANT],
  ["Stripe key", "stripe-key", `charge with ${STRIPE}`, STRIPE],
  ["Google API key", "google-api-key", `?key=${GOOGLE}`, GOOGLE],
  ["JWT", "jwt", `session ${JWT} ok`, JWT],
  ["chat token", "slack-token", `bot ${SLACK} ok`, SLACK],
  ["PEM private key", "pem-private-key", `before\n${PEM}\nafter`, PEM],
  [
    "password in a URL",
    "url-password",
    "git clone https://deploy:s3cr3tPass@git.example.com/repo.git",
    "s3cr3tPass",
  ],
  [
    "Authorization: Bearer",
    "authorization",
    'curl -H "Authorization: Bearer abc123.def456-ghi789" https://x',
    "abc123.def456-ghi789",
  ],
  [
    "Authorization: Basic",
    "authorization",
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "dXNlcjpwYXNzd29yZA==",
  ],
  [
    "Authorization in JSON",
    "authorization",
    '{"Authorization": "Bearer tok_8f7e6d5c4b3a"}',
    "tok_8f7e6d5c4b3a",
  ],
  [
    "bare Bearer token",
    "bearer-token",
    "got Bearer abcdefghij1234567890zz back",
    "abcdefghij1234567890zz",
  ],
  ["password=", "password", "DB_PASSWORD=hunter2 npm start", "hunter2"],
  ["password: in YAML", "password", "password: correcthorse", "correcthorse"],
  ["quoted password", "password", `{"password": "my pass phrase"}`, "my pass phrase"],
  ["senha=", "password", "senha=segredo123 no arquivo", "segredo123"],
  ["token=", "token", "https://api.example.com/x?token=abcDEF123&page=2", "abcDEF123"],
  ["api_key=", "token", "API_KEY=zx81-4411-aa", "zx81-4411-aa"],
  [
    "aws_secret_access_key",
    "token",
    "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
  ],
  ["quoted token in JSON", "token", `{"token":"opaque-value-77"}`, "opaque-value-77"],
];

describe("redactSecrets: each pattern", () => {
  it.each(CASES)("takes out the %s", (_name, kind, line, secret) => {
    const result = redactSecrets(line);
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain(redactionMarker(kind));
    expect(result.count).toBe(1);
    expect(result.kinds).toEqual([kind]);
  });

  it("covers at least ten patterns", () => {
    const covered = new Set(CASES.map(([, kind]) => kind));
    expect(covered.size).toBeGreaterThanOrEqual(10);
    expect([...covered].sort()).toEqual([...REDACTION_KINDS].sort());
  });

  it("keeps the words around the secret", () => {
    expect(redactSecrets(`aws_key is ${AWS} today`).text).toBe(
      "aws_key is [REDACTED:aws-access-key] today",
    );
    expect(redactSecrets("DB_PASSWORD=hunter2 npm start").text).toBe(
      "DB_PASSWORD=[REDACTED:password] npm start",
    );
    expect(redactSecrets("git clone https://deploy:s3cr3tPass@git.example.com/repo.git").text).toBe(
      "git clone https://deploy:[REDACTED:url-password]@git.example.com/repo.git",
    );
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==").text).toBe(
      "Authorization: Basic [REDACTED:authorization]",
    );
  });

  it("takes out the whole PEM block, even when its end was cut off", () => {
    const cut = `log\n-----BEGIN ${"PRIVATE KEY"}-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nmore base64 lines`;
    const result = redactSecrets(cut);
    expect(result.text).toBe("log\n[REDACTED:pem-private-key]");
    expect(result.count).toBe(1);
  });

  it("counts every secret, and names each kind once", () => {
    const text = `a ${AWS}\nb ${GITHUB}\nc ${AWS_TEMP}\nd password=x1`;
    const result = redactSecrets(text);
    expect(result.count).toBe(4);
    expect(result.kinds).toEqual(["aws-access-key", "github-token", "password"]);
  });

  it("counts a secret that two patterns recognise once", () => {
    const result = redactSecrets(`GITHUB_TOKEN=${GITHUB}`);
    expect(result.count).toBe(1);
    expect(result.text).not.toContain(GITHUB);
  });

  it("takes out the secret in the env var it was exported under", () => {
    const result = redactSecrets(`export OPENAI_API_KEY=${SK}\nexport GH_TOKEN=${GITHUB}`);
    expect(result.text).not.toContain(SK);
    expect(result.text).not.toContain(GITHUB);
    expect(result.count).toBe(2);
  });

  it("swaps a secret again that sits next to a marker, once each", () => {
    const once = redactSecrets(`${AWS} ${AWS}`);
    expect(once.count).toBe(2);
    expect(once.text).toBe("[REDACTED:aws-access-key] [REDACTED:aws-access-key]");
  });
});

describe("redactSecrets: what is not a secret", () => {
  const SAFE: readonly [string, string][] = [
    ["a git commit sha", "commit 9e3d2f9a7b1c4d5e6f708192a3b4c5d6e7f80912 (HEAD -> main)"],
    ["a short sha", "b0e2d9e NOR-F10-02b: AI providers in the settings screen"],
    ["a uuid", "id 550e8400-e29b-41d4-a716-446655440000 created"],
    ["a sha-256 hash", "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["a md5 hash", "md5 d41d8cd98f00b204e9800998ecf8427e"],
    ["the word password alone", "Reset your password from the settings page."],
    ["password with no value", "Password:\nnext line"],
    ["password at the end of a line", "enter the password: "],
    ["a password that is a variable", "DB_PASSWORD=${DB_PASSWORD} and PASSWORD=$PASS"],
    ["a placeholder", "password=<your-password> token=<token>"],
    ["a mask", "password=******** api_key=****"],
    ["sk with no token", "the sk- prefix is used by some providers"],
    ["a short sk- word", "sk-learn and sk-short are not keys"],
    ["a long sk- word with no digit", "this is sk-abcdefghijklmnopqrstuvwxyz-words-only"],
    ["risk-free", "a risk-free-investment-with-no-digits-whatsoever-at-all"],
    ["the word token", "the token expired, ask for a new token"],
    ["tokens, plural", "max_tokens=4096 and tokens: 12"],
    ["a port in a URL", "http://localhost:8080/path@x and https://example.com:443/a"],
    ["a URL with only a user", "ssh://git@github.com:22/owner/repo.git"],
    ["an Authorization header with no value", "Authorization: required"],
    [
      "pt-BR text",
      "A senha: deve ter 8 caracteres. Digite sua senha para continuar, está tudo ok.",
    ],
    [
      "pt-BR text with accents",
      "Não foi possível autenticar o usuário; tente novamente mais tarde.",
    ],
    ["the current directory", "PWD=/home/user/project OLDPWD=/home/user"],
    ["a plain terminal screen", "fake$ ls\nREADME.md  src  target\nfake$ seq 3\n1\n2\n3\nfake$ "],
    [
      "a PEM public key",
      "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0B\n-----END PUBLIC KEY-----",
    ],
    ["an AKIA-looking word that is too short", "AKIA1234 is not a key"],
  ];

  it.each(SAFE)("leaves %s alone", (_name, text) => {
    expect(redactSecrets(text)).toEqual({ text, count: 0, kinds: [] });
  });

  it("is idempotent on the examples", () => {
    for (const [, , line] of CASES) {
      const first = redactSecrets(line);
      const second = redactSecrets(first.text);
      expect(second.text).toBe(first.text);
      expect(second.count).toBe(0);
    }
  });
});

describe("redactSecrets: properties", () => {
  const alnum = (alphabet: string, min: number, max: number): fc.Arbitrary<string> =>
    fc
      .array(fc.constantFrom(...alphabet), { minLength: min, maxLength: max })
      .map((chars) => chars.join(""));
  const UPPER_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const MIXED = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const B64URL = `${MIXED}_-`;

  /** Made-up secrets of every shape the patterns know, each with the kind that must find it. */
  const secrets: fc.Arbitrary<[RedactionKind, string]> = fc.oneof(
    alnum(UPPER_DIGITS, 16, 16).map((tail): [RedactionKind, string] => [
      "aws-access-key",
      "AK" + "IA" + tail,
    ]),
    alnum(MIXED, 20, 60).map((tail): [RedactionKind, string] => [
      "github-token",
      "gh" + "p_" + tail,
    ]),
    alnum(`${MIXED}_`, 20, 60).map((tail): [RedactionKind, string] => [
      "github-token",
      "github" + "_pat_" + tail,
    ]),
    fc
      .tuple(alnum("abcdefghijklmnopqrstuvwxyz", 0, 18), alnum(MIXED, 4, 30))
      .map(([letters, tail]): [RedactionKind, string] => [
        "sk-key",
        "s" + "k-" + letters + "1" + tail + "xxxxxxxxxxxxxxxxxxxx".slice(0, 20),
      ]),
    fc
      .tuple(alnum(B64URL, 8, 30), alnum(B64URL, 8, 40), alnum(B64URL, 8, 40))
      .map(([h, p, s]): [RedactionKind, string] => ["jwt", `ey${"J" + h}.ey${"J" + p}.${s}`]),
    alnum(`${MIXED}-`, 10, 40).map((tail): [RedactionKind, string] => [
      "slack-token",
      "xo" + "xb-" + tail,
    ]),
    alnum(MIXED, 1, 40).map((body): [RedactionKind, string] => [
      "pem-private-key",
      `-----BEGIN ${"PRIVATE KEY"}-----\n${body}\n-----END ${"PRIVATE KEY"}-----`,
    ]),
  );

  /** Text with nothing in it that looks like a secret: lower case words, numbers and a few marks. */
  const calmText = fc
    .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz  \n0123456789.,;()"), { maxLength: 200 })
    .map((chars) => chars.join(""));

  it("never leaves the secret in the output, whatever surrounds it", () => {
    fc.assert(
      fc.property(secrets, calmText, calmText, ([kind, secret], before, after) => {
        const result = redactSecrets(`${before} ${secret} ${after}`);
        expect(result.text).not.toContain(secret);
        expect(result.count).toBeGreaterThanOrEqual(1);
        expect(result.kinds).toContain(kind);
      }),
      { numRuns: 300 },
    );
  });

  it("never leaves a password value in the output", () => {
    const value = alnum(MIXED, 1, 24);
    const key = fc.constantFrom("password", "PASSWORD", "db_password", "passwd", "senha");
    fc.assert(
      fc.property(key, value, calmText, (name, secret, after) => {
        const result = redactSecrets(`${name}=${secret}\n${after}`);
        expect(result.text).toBe(`${name}=[REDACTED:password]\n${after}`);
        expect(result.count).toBe(1);
      }),
      { numRuns: 200 },
    );
  });

  it("gives back a text with no secret in it as it was, with a count of zero", () => {
    fc.assert(
      fc.property(calmText, (text) => {
        expect(redactSecrets(text)).toEqual({ text, count: 0, kinds: [] });
      }),
      { numRuns: 300 },
    );
  });

  it("never throws, and counts as many markers as it reports", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), (text) => {
        const result = redactSecrets(text);
        expect(result.count).toBe(result.text.split("[REDACTED:").length - 1 - markersIn(text));
      }),
      { numRuns: 300 },
    );
  });

  it("swaps nothing more when it runs over its own output", () => {
    const withSecret = fc
      .tuple(secrets, calmText, calmText)
      .map(([[, secret], before, after]) => `${before} password=${secret} ${after} ${secret}`);
    fc.assert(
      fc.property(withSecret, (text) => {
        const first = redactSecrets(text);
        const second = redactSecrets(first.text);
        expect(second.text).toBe(first.text);
        expect(second.count).toBe(0);
      }),
      { numRuns: 300 },
    );
  });
});

/** How many markers a text already holds before it is redacted. */
function markersIn(text: string): number {
  return text.split("[REDACTED:").length - 1;
}
