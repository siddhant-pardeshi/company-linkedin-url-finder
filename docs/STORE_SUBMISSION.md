# Store submission checklist

> **Status: prepared, not submitted.** No Chrome Web Store or Microsoft Edge Add-ons submission has been made. This project has no developer-account access, final privacy-policy URL, review token, or production resolver origin. Store review is not implied by building or packaging the extension.

## What is already ready

- MV3 source, tests, CI, docs.
- Icons: `apps/extension/static/icons/icon-{16,32,48,128}.png` (also copied into the build).
- Restrictive extension-page CSP, no remote code, no content scripts.
- Minimal permissions: `storage`, `alarms`, `downloads`, one resolver host.
- Listing copy (below) and permission justifications.
- Reproducible ZIP tooling: `npm run package`.
- A real-browser smoke checklist: [docs/context/VERIFICATION.md](context/VERIFICATION.md).

## Blocking items before any submission

1. **Deploy the resolver** over HTTPS and confirm provider terms in writing for your use.
2. **Build with the real origin**: `RESOLVER_ORIGIN=https://your-resolver.example npm run build` (PowerShell: `$env:RESOLVER_ORIGIN="…"; npm run build`).
3. **Provision a review access token** for store testers, and a small test plan that does not require your private data.
4. **Publish a privacy policy** at a public HTTPS URL; replace the placeholders in [PRIVACY.md](PRIVACY.md).
5. **Finalize listing assets** (screenshots, small promo tile) and the support/contact details.
6. **Decide the legal entity and trademark disclaimer** for the listing.
7. **Confirm data disclosures** match the deployed resolver’s retention/logging.
8. **Run `npm run package`** with a non-placeholder origin; record the SHA-256 hashes.
9. **Obtain explicit owner authorization** for the store accounts and submission.

`npm run package` refuses to build store artifacts while the manifest still contains `resolver.example.com`. Use `--allow-unconfigured` only for local QA; such ZIPs are named `UNCONFIGURED` and must not be submitted.

## Permission justifications (Chrome Web Store)

| Permission                 | Justification                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                  | Persist the user’s resolver token, batching preferences, and retention choice locally. No remote sync.                                                                        |
| `alarms`                   | Keep a checkpointed batch moving and resume after a Manifest V3 service worker sleeps or a provider cooldown ends. Without it, jobs would stall when the worker is suspended. |
| `downloads`                | Let the user save CSV/JSON results. All export generation is local.                                                                                                           |
| Host `<resolver origin>/*` | Send company lookups to the operator’s resolver, which holds the licensed search-provider key. The origin is fixed at build time; no `<all_urls>`.                            |

No `tabs`, `activeTab`, `scripting`, `webRequest`, `history`, `cookies`, `management`, `clipboardRead`, or LinkedIn host permissions.

## Single purpose

“Resolve a bulk list of company names to evidence-backed LinkedIn company page URLs, with human review for ambiguity.”

## Data usage disclosures

Suggested answers (verify against the deployed implementation):

- Does the extension collect personally identifiable information? **No**, not for the extension’s own use. Company names and optional business context are transmitted to the operator’s resolver to perform the requested lookup. No user accounts or profile data.
- Authentication information? **Yes** — a user-provisioned resolver access token is stored locally to authenticate API requests.
- Personal communications, health, financial, location, web history? **No.**
- Website content? **No.** The extension does not read pages, inject content scripts, or access LinkedIn.
- Selling data to third parties? **No.**
- Using data for purposes unrelated to the single purpose? **No.**
- Using data to determine creditworthiness or for lending? **No.**
- Remote code? **No.** All JavaScript is bundled at build time; no `eval`, no CDN scripts.

The provider receives search queries derived from company names and optional context. Disclose the provider relationship and link the operator privacy policy.

## Listing copy

**Name:** Company Page Finder

**Short description (≤132 chars):**

> Bulk company names to evidence-backed LinkedIn company page URLs, with review for anything ambiguous.

**Detailed description:**

> Company Page Finder helps you clean up a list of company names. Paste up to 5,000 names or import a CSV with optional country, domain, and alias context.
>
> Every URL must come from a licensed search provider and pass strict validation. The matching rules are deterministic: no language model, no guessed slugs, no LinkedIn scraping, no login. If two pages could be the same company, or the evidence is weak, the row goes to Review with no URL selected.
>
> Features: resumable batches, pause/cancel/retry, sortable results, per-candidate evidence, human accept/reject with a local audit trail, CSV/JSON export including errors and review rows.
>
> The extension stores job data locally and sends only the company lookups you request to the resolver you configure. It never requests a LinkedIn host permission.
>
> Not affiliated with or endorsed by LinkedIn.

**Category:** Productivity / Business tools.

**Support:** `<support URL or email>`

## Required assets

| Asset              | Requirement                                   | Status                                                                                                               |
| ------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Extension icon     | 128×128 PNG (store), plus 16/32/48 in package | Ready                                                                                                                |
| Screenshots        | 1280×800 or 640×400, 1–5 per store            | Ready to capture from `docs/assets`; final listing shots must be regenerated after the production origin is baked in |
| Small promo tile   | 440×280 PNG                                   | **Missing**                                                                                                          |
| Marquee promo      | Optional 1400×560                             | Not planned                                                                                                          |
| Privacy policy URL | Public HTTPS                                  | **Missing**                                                                                                          |
| Support URL/email  | Public                                        | **Missing**                                                                                                          |

Screenshots should show: intake, results with mixed statuses, and the evidence review drawer. Avoid real customer data; use the sanitized fixtures.

## Reviewer test plan

1. Install the unpacked/store build.
2. Open the workspace from the toolbar.
3. In Settings, paste the reviewer token provided by the operator; choose **Save & test** and confirm “Connected”.
4. Return to the workspace; click **Load example list** (sanitized fixtures) or paste 3–5 public company names.
5. Start the batch; observe progress.
6. Open **Review** on a review row; inspect candidates and queries; optionally accept one.
7. Export CSV and JSON; confirm the files include matched, review, not-found, and error rows.

Provide the reviewer token privately in the store dashboard, not in the listing or repository.

## Chrome Web Store steps (manual)

1. Register/verify the Chrome Web Store developer account and pay any current registration fee.
2. Create a new item; upload `dist/packages/company-page-finder-v<version>-chrome.zip`.
3. Fill the store listing with the copy and assets above.
4. Complete the privacy practices form; provide the privacy-policy URL.
5. Add the permission justifications and single-purpose statement.
6. Add reviewer instructions and the review token.
7. Submit for review. **Do not claim approval until the dashboard shows it.**
8. After approval, publish; verify the live listing and version.

## Microsoft Edge Add-ons steps (manual)

1. Register in Microsoft Partner Center (Edge program).
2. Create a new extension; upload the Edge ZIP from `dist/packages/`.
3. Provide listing metadata, privacy policy, support contact, and the same permission justifications.
4. Add reviewer notes/token.
5. Submit and wait for certification; verify the live listing before announcing.

## Release checklist

- [ ] `npm ci`
- [ ] `npm run check`
- [ ] Browser smoke test in Chrome and Edge (manual)
- [ ] `RESOLVER_ORIGIN` set to the production HTTPS origin
- [ ] `npm run package`
- [ ] SHA-256 hashes recorded (`dist/packages/SHA256SUMS.txt`)
- [ ] Version bumped in `package.json` and `apps/extension/manifest.base.json`
- [ ] Privacy policy and support URLs live
- [ ] Reviewer token provisioned and tested
- [ ] No `.env`, token, CSV, log, or `dist/` artifact committed
- [ ] Owner authorization recorded

## Version history

| Version | Date       | Notes                               |
| ------- | ---------- | ----------------------------------- |
| 1.0.0   | 2026-11-26 | Initial local build; not submitted. |
