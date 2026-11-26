# Contributing

Thanks for helping improve Company Page Finder. The project’s value is its accuracy discipline; contributions that weaken it will be rejected even if they improve match counts.

## Setup

Requirements: Node.js 20.19+ (CI uses Node 24), npm.

```bash
npm ci
cp .env.example .env
```

For the offline demo, set in `.env`:

```dotenv
SEARCH_PROVIDER=mock
RESOLVER_ACCESS_TOKENS=local-dev-token-1234567890
```

```bash
npm run api:start          # terminal 1
npm run build:dev          # terminal 2
```

Load `dist/extension-dev` unpacked in Chrome/Edge, save the token in Settings, and use the example list.

## Commands

| Command                           | Purpose                                           |
| --------------------------------- | ------------------------------------------------- |
| `npm run typecheck`               | Strict TypeScript for matching/API/extension      |
| `npm run lint`                    | ESLint, zero warnings                             |
| `npm run format` / `format:check` | Prettier                                          |
| `npm test`                        | All unit/integration tests                        |
| `npm run coverage`                | v8 coverage                                       |
| `npm run build` / `build:dev`     | Production/development extension                  |
| `npm run build:api`               | Bundled resolver                                  |
| `npm run validate:dist`           | Manifest/permission/CSP/secret/package validation |
| `npm run package`                 | Chrome/Edge ZIPs (refuses placeholder origin)     |
| `npm run check`                   | The main gate, in order                           |

## Non-negotiable correctness rules

1. Never construct `linkedin.com/company/<slug>` from a name, alias, domain, or inference.
2. A selected URL must come from a provider result that passed `parseLinkedInCompanyUrl`.
3. Do not add an LLM or opaque model score to the decision path. Fuzzy scores may only order a review list.
4. Ambiguity must produce `REVIEW_REQUIRED` with a blank selected URL.
5. Provider/network/auth failures must remain `ERROR`; never convert them to a match.
6. Only request provider-returned candidates in the review flow. Human acceptance of an excluded candidate requires an explicit override and audit entry.
7. Do not add LinkedIn host permissions, content scripts, scraping, automation, cookies, or unofficial APIs.
8. Do not log company names, queries, URLs, tokens, or payloads on the server.
9. Preserve every original input row in results and exports.
10. Keep the extension permission surface minimal; justify any addition in the PR.

## Where changes belong

- `packages/matching` — pure rules, normalization, URL validation, query planning, schemas. No network/DOM/clock/AI.
- `apps/api` — provider adapters, HTTP/auth/limits, resolver behavior. No matching decisions.
- `apps/extension` — UI, persistence, job orchestration, human review.
- `packages/test-fixtures` — sanitized fake data only. Never import it into the packaged extension.

## Tests

Every behavior change needs a test at the same layer:

- URL/normalization/query/rules → `packages/matching/test`.
- Provider, auth, cache, retry, rate limit, HTTP → `apps/api/test`.
- Job persistence/resume, settings, CSV/export, client, manifest → `apps/extension/test`.
- Cross-cutting UI flow → real-browser smoke (`tools/e2e-smoke.mjs`) updated when the flow changes.

Do not delete, skip, or weaken a test to make a change pass. If an assertion is wrong, explain why in the PR and fix the assertion deliberately.

## Style

- Strict TypeScript; no `any` (ESLint enforces).
- Pure functions for matching; dependency injection for time/sleep/fetch so tests are deterministic.
- Prefer small modules and explicit types at boundaries.
- Accessible UI: keyboard operation, labels, focus-visible, `aria-live` for status, no color-only meaning.
- Provider text is untrusted: use `textContent`, never interpolate it into HTML.
- Run `npm run format` before committing.

## Commits and PRs

- Small, logical commits with a clear message.
- One concern per PR; call out any change to accuracy, permissions, or data handling explicitly.
- Include: what changed, why, tests run, and any known limitation.
- CI must be green; do not merge with skipped tests.
- Do not commit `.env`, tokens, real customer CSVs, logs, `dist/`, or generated lookup data.

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities privately, not in a public issue.

## License

By contributing you agree that your contribution is licensed under the MIT License.
