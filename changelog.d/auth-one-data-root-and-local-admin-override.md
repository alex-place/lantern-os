fix(auth): one data root, and LANTERN_ADMIN_IDS now works for email/password accounts

Role changes could silently not take effect. Every auth store (profiles, sessions,
action tokens, verify codes, billing ledger, mail outbox) resolved its path from
`process.cwd()`, so a CLI script and the running server read two different stores
depending on how each was started — `setUserRole()` reported success against a file
the server never opened (#3088). All of them now resolve through the
existing `lib/app-paths.js` seam (ADR-0014 G2), which is cwd-independent, and the
server prints the resolved root at startup.

`LANTERN_ADMIN_IDS` also had no effect on an email/password login: the override was
only consulted on the OAuth path, so a deploy without working Google sign-in had no
way to reach admin via the documented env var (#3087). Local login now applies the
same elevation, `local:` entries match case-insensitively, and an entry that can
never match — including a bare id, which is read as a Google id — warns at startup
instead of failing silently.
