# Verification log

Local verification of **Company Page Finder 1.1.0** on **2026-11-26** (Windows, Node 24.20.0, npm 11.19.0, Chrome for Testing 158.0.8127.88).

## Automated gates

| Gate                       | Command                 | Result                                                              |
| -------------------------- | ----------------------- | ------------------------------------------------------------------- |
| Strict TypeScript          | `npm run typecheck`     | Pass (matching, API, extension)                                     |
| Lint                       | `npm run lint`          | Pass, 0 warnings/errors                                             |
| Formatting                 | `npm run format:check`  | Pass                                                                |
| Unit + integration         | `npm test`              | **237 tests in 19 files, all pass**                                 |
| Coverage                   | `npm run coverage`      | 81.46% statements, 79.81% branches, 86.34% functions                |
| Production extension build | `npm run build`         | Pass; placeholder origin warning by design                          |
| Resolver build             | `npm run build:api`     | Pass (`dist/api/server.js`)                                         |
| Distribution validation    | `npm run validate:dist` | Pass: MV3, required + optional permissions, CSP, no bundled secrets |

New in 1.1.0 test coverage: `/in/` URL validation, person-name normalization (`Last, First`, credentials), profile-title extraction, person query planning, strict person decisions, person request schema, AI query validation, Gemini/xAI/OpenRouter request/response adapters, AI settings, mixed-mode rejection, person job execution, AI-assisted person batch and fallback note, people CSV import/export, and optional host-permission manifest rules.

## Real-browser smoke test

Environment:

- Chrome for Testing **158.0.8127.88** (branded Chrome builds ignore `--load-extension`).
- Unpacked build `dist/extension-dev`.
- Local resolver on `http://127.0.0.1:8787` with `SEARCH_PROVIDER=mock`; the resolver token was provisioned through the real Settings page.
- Real service worker, IndexedDB, alarms, optional-permission manifest, and UI driven over the DevTools Protocol.

Command:

```powershell
npm run build:dev
# Chrome for Testing launched with --load-extension=%CD%\dist\extension-dev --remote-debugging-port=9223
node tools/e2e-smoke.mjs
```

Result: **31 / 31 checks passed**, no browser console errors.

- Company flow (22 checks): load, token gate, options save/test, example import, completed batch, stats `5/2/2/1/0/0`, all rows, Microsoft `/company/microsoft/`, Acme review, Initech not found, review drawer candidates/queries, accept → selected URL, audit entry, 900 px card layout with no overflow.
- AI settings surface (1 check): AI section present, off by default, Gemini default model.
- People flow (7 checks): mode labels switch, four-row people CSV import, batch start/completion, stats `4/2/1/1/0/0`, `Person` column, Ada `/in/ada-lovelace/`, Alan Turing two-candidate review.
- Console-error guard (1 check).

Screenshots (sanitized fixtures only): `workspace-top.png`, `workspace-results.png`, `review-drawer.png`, `workspace-narrow.png`, `workspace-people.png`, `options.png`, `options-ai.png`. Copies are in `docs/assets/`.

**Not tested live:** an actual Gemini/xAI/OpenRouter request with a real key. Those adapters are covered by mocked request/response tests; the optional host-permission prompt is a Chrome UI gesture and was not auto-approved in headless testing. The deterministic path is fully tested with AI disabled.

## Manual checks performed

- API `GET /healthz` returned `{ok:true, provider:"mock", version:"1.1.0"}`.
- `GET /v1/whoami` without a bearer token returned `401`; with the token, `{ok:true,...}`.
- Company and people `POST /v1/search` batches ran through the real resolver and mock provider.
- `chrome.runtime.sendMessage` round-trips for settings, jobs, rows, audit, review, and AI settings.
- Created, persisted, and read jobs through IndexedDB in the real browser.
- Verified icons, tabs, dialogs, focus-visible styling, and responsive layout at 1440×1000 and 900×900.

## Build artifacts

Built locally with the placeholder origin `https://resolver.example.com` because no production resolver was deployed and no origin was provided. Version 1.1.0.

| Artifact                                    | Path                                                               | SHA-256                  |
| ------------------------------------------- | ------------------------------------------------------------------ | ------------------------ |
| Chrome QA ZIP (unconfigured)                | `dist/packages/company-page-finder-v1.1.0-UNCONFIGURED-chrome.zip` | _filled after packaging_ |
| Edge QA ZIP (unconfigured, identical bytes) | `dist/packages/company-page-finder-v1.1.0-UNCONFIGURED-edge.zip`   | _filled after packaging_ |

Package size: _filled after packaging_. `manifest.json` is at the ZIP root.

The extracted production ZIP was loaded into Chrome for Testing; the service worker started, `app:info` reported production/version/commit/endpoint, and the workspace rendered with Start disabled until a token is configured.

Microsoft Edge is not installed on this machine, so Edge was not manually loaded. The Edge ZIP is byte-identical (same Chromium MV3 package); manual Edge verification remains an owner action.

These are **QA artifacts**, not store-ready packages. `npm run package` refuses a placeholder origin without `--allow-unconfigured`.

## Sync status

- Local Git history: initial build `00636c5d61dc1ec00be8c9585a85f05e891b8b59`, verification docs `8c70a5d018870df44022082681ef5b1a0b228967`, domain fix `117506fa4db4658b23a8f653148d683238f5e12d`, CSV hardening `99ccbb89c1e0b1e1cd8abe141f6e690fce0070de`, docs clarifications `6f5b54e`, `703e803`, plus the 1.1.0 feature commit and this verification commit.
- GitHub remote: **none**. `gh auth status` reported “You are not logged into any GitHub hosts.” No push, release, or remote SHA was created or claimed.
- Chrome Web Store / Edge Add-ons: **not submitted** (no developer-account access or owner authorization).

## Local context folder

`docs/context/` contains the verified references, decisions, and this log. Product screenshots are in `docs/assets/`.

## Remaining owner actions

1. Deploy the resolver with a real HTTPS origin, Brave key, and access token.
2. Rebuild with `RESOLVER_ORIGIN`, then run `npm run package` and record the real hashes.
3. Authenticate GitHub, create/push `company-linkedin-url-finder`, and verify the remote commit SHA.
4. Publish a privacy-policy/support URL, finalize listing assets, provision a reviewer token, and authorize store submission.
5. Optionally test a real AI key on each provider you plan to advertise; model IDs and quotas change.
