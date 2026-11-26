# Security policy

## Reporting a vulnerability

Do **not** open a public issue for a suspected secret leak, authentication bypass, SSRF, injection, or permission issue.

Publication checklist item: replace this placeholder with a monitored security contact before release.

- Security contact: `<security@example.com>`
- Include: affected version/commit, impact, reproduction steps, and whether a token or provider key may be exposed.
- Do not include real access tokens, provider keys, customer CSVs, or personal data in the report.

This is a small open-source project without a paid bug bounty. Reports are handled on a best-effort basis; coordinated disclosure is appreciated.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |

## Security design summary

- **Secrets** — the search-provider key exists only in the resolver environment/secret store. The extension bundle contains no search-provider key, endpoint, or header. Resolver access tokens are compared as SHA-256 digests in constant time and never logged. Optional AI keys are stored locally in `chrome.storage.local` and sent only to the selected AI provider; anyone with profile access can read them, which is documented as a BYOK trade-off.
- **Permissions** — MV3, `storage` + `alarms` + `downloads`, one resolver host, and three optional AI hosts requested only when assist is enabled. No content scripts, no `<all_urls>`, no LinkedIn host.
- **Remote code** — none. All JS is bundled at build time; the extension CSP is `script-src 'self'; object-src 'self';`.
- **Input limits** — 64 KiB request body, 25 lookups, 200-character names, 120–500-character context fields, strict JSON validation, 90-second HTTP ceiling, 50-second batch budget.
- **URL handling** — exact LinkedIn host/path validation, no redirects, no scraping, no URL construction from input. Selected URLs must be discovered candidates.
- **Output encoding** — provider text is rendered with `textContent`; links are restricted to canonical `https://www.linkedin.com/company/` URLs. CSV cells are escaped.
- **Provider failures** — typed, rate-limited, bounded retries with jitter; long `Retry-After` windows pause the job instead of being ignored.
- **Logging** — no names, queries, URLs, payloads, or tokens.

## Deployment checklist

- [ ] HTTPS termination with a valid certificate.
- [ ] `NODE_ENV=production`, `SEARCH_PROVIDER=brave`.
- [ ] Long random `RESOLVER_ACCESS_TOKENS` stored in a secret manager; rotate on exposure.
- [ ] Provider key restricted to the search API and rotated periodically.
- [ ] Rate limits/quotas appropriate for your plan; optional external limiter for multiple instances.
- [ ] Logs reviewed for accidental data capture; retention configured at the host/proxy.
- [ ] `ALLOWED_ORIGINS` set only if a web origin legitimately calls the resolver.
- [ ] AI keys are treated as user secrets: optional host permissions only, no logs/exports, and a clear local-key warning.
- [ ] Dependency updates (`npm audit`, provider API changes) reviewed.
- [ ] Store/reviewer tokens scoped to a time-limited test deployment where possible.

## Known limitations

- The reference resolver keeps rate-limit and idempotency state in memory; a multi-instance deployment needs a shared store or an upstream limiter.
- The extension stores the access token in `chrome.storage.local` in plain text, protected by the browser profile/OS account. Shared profiles are not a secure boundary.
- A human-confirmed URL is a human decision, not a cryptographic proof of identity.

## Out of scope

- Vulnerabilities requiring an already-compromised browser profile or OS.
- Provider-side outages, index errors, or terms changes.
- LinkedIn-side access controls (the extension does not access LinkedIn).
