# Verification log

Local verification of the `Company Page Finder` build on **2026-11-26** (Windows, Node 24.20.0, npm 11.19.0, Chrome for Testing 158.0.8127.88).

## Automated gates

| Gate | Command | Result |
| --- | --- | --- |
| Strict TypeScript | `npm run typecheck` | Pass (matching, API, extension) |
| Lint | `npm run lint` | Pass, 0 warnings/errors |
| Formatting | `npm run format:check` | Pass |
| Unit + integration | `npm test` | **202 tests in 17 files, all pass** |
| Coverage | `npm run coverage` | ~80% statements overall (thresholds 70/70/70/65) |
| Production extension build | `npm run build` | Pass; placeholder origin warning by design |
| Resolver build | `npm run build:api` | Pass (`dist/api/server.js`) |
| Distribution validation | `npm run validate:dist` | Pass: MV3, `storage+alarms+downloads`, one host, CSP, no secrets in JS |

Test files cover: URL validation/canonicalization, normalization/legal suffixes, query planning, deterministic decisions, API schema, Brave adapter, retries/backoff, token bucket, idempotency cache, semaphore, HTTP auth/rate-limit/CORS/body-size/idempotency/errors, resolver service behavior, job engine durability/pause/resume/cancel/retry/context updates/user decisions, IndexedDB persistence, settings, resolver client, CSV/JSON import-export, view filtering/sorting/pagination, manifest/permission boundaries, and environment loading.

## Real-browser smoke test

Environment:

- Chrome for Testing **158.0.8127.88** (Chrome branded builds now ignore `--load-extension`).
- Unpacked build `dist/extension-dev`.
- Local resolver on `http://127.0.0.1:8787` with `SEARCH_PROVIDER=mock`, access token provisioned through the real Settings page.
- Driven over the DevTools Protocol with the real service worker, IndexedDB, alarms API, and UI.

Command:

```powershell
npm run build:dev
# Chrome for Testing launched with --load-extension=%CD%\dist\extension-dev --remote-debugging-port=9223
node tools/e2e-smoke.mjs
```

Result: **23 / 23 checks passed**, with no browser console errors:

1. Workspace loads and renders.
2. Missing-token guidance is visible; Start is disabled without a token.
3. Development build badge is visible.
4. Settings page saves the resolver token.
5. Connection test succeeds and reports the mock provider.
6. Start enables with a valid pasted list.
7. Import summary counts five valid rows.
8. Batch completes end to end.
9. Stats are `5/2/2/1/0/0` (rows/matched/review/not-found/errors/pending).
10. All five original rows are rendered.
11. Microsoft is high-confidence with the discovered canonical URL.
12. Acme is routed to review.
13. Initech is not found.
14. Review drawer shows both Acme candidates.
15. Review drawer shows provider queries and evidence.
16. Accepting a candidate sets the selected URL.
17. Human confirmation is written to the audit trail.
18. Narrow viewport switches to readable result cards.
19. Narrow viewport has no horizontal table overflow.
20. No browser console errors.

Screenshots (also copied to `docs/assets/`): `workspace-top.png`, `workspace-results.png`, `review-drawer.png`, `workspace-narrow.png`, `options.png`. They use sanitized fixtures only.

## Manual checks performed

- API `GET /healthz` returned `{ok:true, provider:"mock", version:"1.0.0"}`.
- `GET /v1/whoami` without a bearer token returned `401`; with the token, `{ok:true,...}`.
- `POST /v1/search` via the extension executed real HTTPS-local traffic from the service worker to the resolver.
- `chrome.runtime.sendMessage` round-trips for settings, jobs, rows, audit, and review actions.
- Created, persisted, and read a job through IndexedDB in the real browser.
- Verified icons, tabs, dialogs, focus-visible styling, and responsive layout at 1440×1000 and 900×900.

## Build artifacts

Built locally with the placeholder origin `https://resolver.example.com` because no production resolver was deployed and no origin was provided.

| Artifact | Path | SHA-256 |
| --- | --- | --- |
| Chrome/Edge QA ZIP (unconfigured) | `dist/packages/company-page-finder-v1.0.0-UNCONFIGURED-chrome.zip` | _filled after packaging_ |
| Edge QA ZIP (unconfigured) | `dist/packages/company-page-finder-v1.0.0-UNCONFIGURED-edge.zip` | _filled after packaging_ |

These are **QA artifacts**, not store-ready packages. `npm run package` intentionally refuses to package a placeholder origin without `--allow-unconfigured`.

## Sync status

- Local git repository commit: _filled after commit_.
- GitHub remote: **none**. `gh auth status` reported “You are not logged into any GitHub hosts.” No push, release, or remote SHA was created or claimed.
- Chrome Web Store / Edge Add-ons: **not submitted** (no developer-account access or owner authorization).

## Local context folder

`docs/context/` contains the verified references, decisions, and this log. Product screenshots are in `docs/assets/`.

## Remaining owner actions

1. Deploy the resolver with a real HTTPS origin, Brave key, and access token.
2. Rebuild with `RESOLVER_ORIGIN`, then run `npm run package` and record the real hashes.
3. Authenticate GitHub, create/push `company-linkedin-url-finder`, and verify the remote commit SHA.
4. Publish a privacy-policy/support URL, finalize listing assets, provision a reviewer token, and authorize store submission.
