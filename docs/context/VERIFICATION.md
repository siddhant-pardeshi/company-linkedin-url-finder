# Verification log

Local verification of the `Company Page Finder` build on **2026-11-26** (Windows, Node 24.20.0, npm 11.19.0, Chrome for Testing 158.0.8127.88).

## Automated gates

| Gate                       | Command                 | Result                                                                                            |
| -------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------- |
| Strict TypeScript          | `npm run typecheck`     | Pass (matching, API, extension)                                                                   |
| Lint                       | `npm run lint`          | Pass, 0 warnings/errors                                                                           |
| Formatting                 | `npm run format:check`  | Pass                                                                                              |
| Unit + integration         | `npm test`              | **202 tests in 17 files, all pass**                                                               |
| Coverage                   | `npm run coverage`      | 81.41% statements, 81.55% branches, 87.89% functions (lines/functions/statements 70, branches 65) |
| Production extension build | `npm run build`         | Pass; placeholder origin warning by design                                                        |
| Resolver build             | `npm run build:api`     | Pass (`dist/api/server.js`)                                                                       |
| Distribution validation    | `npm run validate:dist` | Pass: MV3, `storage+alarms+downloads`, one host, CSP, no secrets in JS                            |

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
2. Missing-token guidance is visible.
3. Start is disabled without a token.
4. Development build badge is visible.
5. Settings page saves the resolver token.
6. Connection test succeeds.
7. Connection test reports the mock provider.
8. Start enables with a valid pasted list.
9. Import summary counts five valid rows.
10. Batch completes end to end.
11. Stats are `5/2/2/1/0/0` (rows/matched/review/not-found/errors/pending).
12. All five original rows are rendered.
13. Microsoft is high-confidence with the discovered canonical URL.
14. Acme is routed to review.
15. Initech is not found.
16. Review drawer shows both Acme candidates.
17. Review drawer shows provider queries and evidence.
18. Accepting a candidate sets the selected URL.
19. Human confirmation is written to the audit trail.
20. Narrow viewport switches to readable result cards.
21. Narrow viewport has no horizontal table overflow.
22. No browser console errors.

That is 22 automated checks plus the separate console-error guard, shown as 23 passes by the script.

Screenshots (also copied to `docs/assets/`): `workspace-top.png`, `workspace-results.png`, `review-drawer.png`, `workspace-narrow.png`, `options.png`. They use sanitized fixtures only.

## Manual checks performed

- API `GET /healthz` returned `{ok:true, provider:"mock", version:"1.0.0"}`.
- `GET /v1/whoami` without a bearer token returned `401`; with the token, `{ok:true,...}`.
- `POST /v1/search` via the extension executed real HTTPS-local traffic from the service worker to the resolver.
- `chrome.runtime.sendMessage` round-trips for settings, jobs, rows, audit, and review actions.
- Created, persisted, and read a job through IndexedDB in the real browser.
- Verified icons, tabs, dialogs, focus-visible styling, and responsive layout at 1440Ã—1000 and 900Ã—900.

## Build artifacts

Built locally with the placeholder origin `https://resolver.example.com` because no production resolver was deployed and no origin was provided.

| Artifact                                    | Path                                                               | SHA-256                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Chrome QA ZIP (unconfigured)                | `dist/packages/company-page-finder-v1.0.0-UNCONFIGURED-chrome.zip` | `cc386a01fc03d54e9a6305e89cec9a4c7daa9b7f3adb21a80344e12b87d189a9` |
| Edge QA ZIP (unconfigured, identical bytes) | `dist/packages/company-page-finder-v1.0.0-UNCONFIGURED-edge.zip`   | `cc386a01fc03d54e9a6305e89cec9a4c7daa9b7f3adb21a80344e12b87d189a9` |

Package size: 68.7 KiB each, 13 files, `manifest.json` at the ZIP root. Build baked commit `117506fa4db4`, build time `2026-11-26T06:32:18.888Z`.

The extracted production ZIP was loaded into Chrome for Testing: the service worker started, `app:info` returned `buildEnv: production`, version `1.0.0`, commit `117506fa4db4`, endpoint `https://resolver.example.com`, the workspace rendered, and Start stayed disabled until a token is configured. No runtime errors were observed.

Microsoft Edge is not installed on this machine, so Edge was not manually loaded. The Edge ZIP is byte-identical (same Chromium MV3 package); manual Edge verification remains an owner action.

These are **QA artifacts**, not store-ready packages. `npm run package` intentionally refuses to package a placeholder origin without `--allow-unconfigured`.

## Sync status

- Local commits: `00636c5d61dc1ec00be8c9585a85f05e891b8b59` (initial build), `8c70a5d018870df44022082681ef5b1a0b228967` (verification docs), `117506fa4db4658b23a8f653148d683238f5e12d` (sentence-end domain fix), plus this verification-doc commit.
- Working tree: clean after the verification commit.
- GitHub remote: **none**. `gh auth status` reported â€œYou are not logged into any GitHub hosts.â€ No push, release, or remote SHA was created or claimed.
- Chrome Web Store / Edge Add-ons: **not submitted** (no developer-account access or owner authorization).

## Local context folder

`docs/context/` contains the verified references, decisions, and this log. Product screenshots are in `docs/assets/`.

## Remaining owner actions

1. Deploy the resolver with a real HTTPS origin, Brave key, and access token.
2. Rebuild with `RESOLVER_ORIGIN`, then run `npm run package` and record the real hashes.
3. Authenticate GitHub, create/push `company-linkedin-url-finder`, and verify the remote commit SHA.
4. Publish a privacy-policy/support URL, finalize listing assets, provision a reviewer token, and authorize store submission.
