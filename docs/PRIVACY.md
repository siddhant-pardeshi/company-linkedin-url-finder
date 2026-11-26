# Privacy

Company Page Finder is designed for business lists. In company mode it processes company names and optional business context. In people mode it processes the person details you explicitly supply (name, company, job title, location, and optionally email/phone for your own export). It does not collect analytics, telemetry, browsing history, LinkedIn credentials, cookies, or scrape personal profiles.

This document describes the reference implementation. If you deploy the resolver for others, you are the operator of that deployment and must adapt this notice, provide a contact, and confirm the search provider’s current terms.

## What the extension sends

For each lookup, the extension sends to the configured resolver:

- the company name or person full name from your input;
- optional context you supplied (country/region/city/domain/alias for companies; company/job title/location for people; notes);
- an idempotency key derived from the job and lookup keys;
- the access token in the `Authorization` header.

Email and phone are stored locally for export only. They are **never** included in resolver requests, search queries, or AI-provider requests.

It does **not** send LinkedIn credentials, cookies, page contents, browsing history, or clipboard data. It does not inject content scripts or read pages you visit.

The resolver converts each lookup into conservative search queries and sends those queries to the configured search provider (Brave Web Search in production). The provider’s own privacy terms govern its processing. Notes are **not** used in queries.

## Optional AI query assist

If you enable AI query assist, the extension sends the person name, company, job title, and location to the AI provider you selected (Google Gemini, xAI, or OpenRouter) using the API key you supplied. The AI returns proposed site-restricted search queries only; it receives no email, phone, resolver token, or LinkedIn data. The AI provider’s terms and data-processing policy apply to that request. If AI assist is disabled or the request fails, no AI data is sent and the deterministic search continues.

## Where data is stored

**In the extension (local to this browser profile):**

- settings in `chrome.storage.local`, including the resolver access token and the optional AI API key in plain text (extension-local storage; protected by your OS account and browser profile);
- jobs, original input rows, evidence, results, audit entries, and optional email/phone fields in IndexedDB.

**On the resolver:**

- no persistent lookup database;
- an in-memory idempotency cache with a default 15-minute TTL (configurable, `0` disables it);
- in-memory rate-limit counters;
- structured operational logs containing request ID, status, counts, and latency — not names, query text, URLs, or tokens.

If you configure a reverse proxy or hosting platform, that provider may keep standard access logs. Review your host’s configuration.

## Retention and deletion

- Finished batches are kept locally for **30 days by default** (configurable to 7/30/90/365 days, or “until I clear them”).
- **Settings → Delete all local data** removes every batch, row, evidence record, audit entry, the resolver token, and the AI API key.
- Deleting a browser profile removes the extension’s local data with it.
- Resolver memory is cleared on restart; the idempotency cache is bounded and expires automatically.
- Exports are ordinary files you save; their retention is under your control.

## Security notes

- The resolver token and optional AI API key are stored locally because the extension must call those services without a login screen. Anyone with access to your browser profile can read them. Use a dedicated profile on shared machines and rotate keys if exposed.
- Resolver tokens are hashed in resolver memory for comparison; raw tokens are never logged. AI keys are sent only to the selected AI provider over HTTPS.
- The licensed search-provider key exists only in the resolver environment/secret store and is never bundled in the extension.
- All resolver and AI-provider traffic should use HTTPS. AI provider hosts are requested as optional permissions and are not granted until you enable assist.

## No sale, no profiling

The reference implementation has no advertising, profiling, analytics, or data sale. It does not create user accounts and does not associate lookups with an identity beyond the bearer token.

## Children

The tool is intended for business use and is not directed at children.

## Changes

Material changes to data handling should update this notice, `docs/ACCURACY_POLICY.md` where relevant, and the store privacy disclosures before release.

## Contact

Publication checklist item: replace this placeholder with the operator’s legal entity, privacy contact email, and privacy-policy URL before store submission.

- Operator: `<owner / legal entity>`
- Privacy contact: `<privacy@example.com>`
- Policy URL: `<https://example.com/privacy>`
- Last updated: 2026-11-26

## Your choices

- Use **Delete all local data** at any time.
- Export your data as CSV or JSON before deleting.
- Do not configure a production token on a shared profile.
- Self-host the resolver if you need a different retention or logging policy.
