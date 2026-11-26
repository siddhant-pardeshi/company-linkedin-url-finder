# Privacy

Company Page Finder is designed for company lists, not personal data. It does not collect analytics, telemetry, browsing history, LinkedIn credentials, cookies, or personal profiles.

This document describes the reference implementation. If you deploy the resolver for others, you are the operator of that deployment and must adapt this notice, provide a contact, and confirm the search provider’s current terms.

## What the extension sends

For each lookup, the extension sends to the configured resolver:

- the company name from your input;
- optional disambiguation fields you supplied (country, region, city, official domain/website, alias, notes);
- an idempotency key derived from the job and lookup keys;
- the access token in the `Authorization` header.

It does **not** send LinkedIn credentials, cookies, page contents, browsing history, clipboard data, or personal profiles. It does not inject content scripts or read pages you visit.

The resolver converts each lookup into conservative search queries and sends those queries to the configured search provider (Brave Web Search in production). The provider’s own privacy terms govern its processing. The resolver does not send your raw CSV or notes to the provider unless they are part of the explicit fields used to build a query; notes are **not** used in queries.

## Where data is stored

**In the extension (local to this browser profile):**

- settings in `chrome.storage.local`, including the access token in plain text (extension-local storage; protected by your OS account and browser profile);
- jobs, original input rows, evidence, results, and audit entries in IndexedDB.

**On the resolver:**

- no persistent lookup database;
- an in-memory idempotency cache with a default 15-minute TTL (configurable, `0` disables it);
- in-memory rate-limit counters;
- structured operational logs containing request ID, status, counts, and latency — not company names, query text, URLs, or tokens.

If you configure a reverse proxy or hosting platform, that provider may keep standard access logs. Review your host’s configuration.

## Retention and deletion

- Finished batches are kept locally for **30 days by default** (configurable to 7/30/90/365 days, or “until I clear them”).
- **Settings → Delete all local data** removes every batch, row, evidence record, audit entry, and the saved token.
- Deleting a browser profile removes the extension’s local data with it.
- Resolver memory is cleared on restart; the idempotency cache is bounded and expires automatically.
- Exports are ordinary files you save; their retention is under your control.

## Security notes

- The token is stored locally because the extension must authenticate to the resolver without a login screen. Anyone with access to your browser profile can read it. Use a dedicated profile on shared machines and rotate tokens if exposed.
- Tokens are hashed in resolver memory for comparison; raw tokens are never logged.
- The provider API key exists only in the resolver environment/secret store and is never bundled in the extension.
- All resolver traffic should use HTTPS. The development build uses `http://127.0.0.1:8787` only for localhost.

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
