# Security policy

## Supported versions

Noren is pre-alpha. There are no stable releases yet, so only the latest commit on `main` is supported. Once releases exist, this table will list the supported release lines.

| Version                  | Supported |
| ------------------------ | --------- |
| `main` (pre-alpha)       | Yes       |
| Anything older than main | No        |

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report vulnerabilities privately through GitHub Security Advisories: open the repository's **Security** tab and choose **Report a vulnerability**.

Include what you found, the steps to reproduce it, the affected version or commit, and the impact you expect. We will acknowledge the report, work on a fix, and coordinate disclosure with you.

## Scope

Areas where a report is especially valuable:

- Terminal and shell integration (escape sequence handling, command execution paths).
- The AI integration: it must never run a command without a user action, never send data to a provider without a preview, and never store API keys outside the system keychain.
- Configuration, theme and mod loading (path traversal, code execution from untrusted files).
- The desktop shell (IPC commands and capabilities).
