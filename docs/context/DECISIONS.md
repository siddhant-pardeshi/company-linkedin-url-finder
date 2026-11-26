# Build decisions

## Product interpretation

The brief’s “Microsoft Bing extension” was interpreted as a **Chromium Manifest V3 extension for Microsoft Edge and Google Chrome**, matching the guide’s explicit interpretation. It is not a Bing website extension and does not use the retired Bing Web Search API.

## Decision log

### 1. Client-side deterministic matching, server-side search proxy

**Decision:** the resolver plans and executes queries and returns verbatim evidence; the extension evaluates the evidence with the shared pure matching package.

**Why:** the decision and its explanation stay auditable next to the stored evidence; the server remains a narrow, replaceable proxy; a server compromise cannot silently change matching rules; rules can be re-run on stored candidates.

**Rejected:** server-side matching (opaque to the local audit trail, couples correctness to a deployment); LLM selection (prohibited and unverifiable).

### 2. Node HTTP resolver instead of a Cloudflare Worker

**Decision:** a dependency-light Node 22+ service, deployable in a container or any Node host, with a Brave adapter and a mock provider.

**Why:** fully testable locally with real HTTP integration tests, no vendor account or bindings required, portable deployment, simple secret handling.

**Trade-off:** horizontal scaling needs a shared rate-limit/idempotency store; the reference is single-instance. Documented.

### 3. Exact normalized title matching, with corroboration for weak names

**Decision:** auto-select only when exactly one candidate’s normalized provider title equals the normalized company name, and (for short/generic/ambiguous names) a domain, country, city, or second-query signal exists.

**Why:** a name alone cannot prove identity. A fuzzy title score is useful for ordering but not evidence. This produces review rows rather than plausible wrong URLs.

**Rejected:** fuzzy slug scoring for selection; “first result wins”; using an LLM to pick.

### 4. “Competing candidates” means exact normalized title matches

**Decision:** a second valid URL with a **different** title (for example `Microsoft India` when the input is `Microsoft`) does not block the unique exact parent page; two pages with the same normalized name do.

**Why:** subsidiary/variant pages are legitimately different entities; an exact-name duplicate is the dangerous ambiguity. The candidates remain visible in review.

### 5. No BYOK in the extension

**Decision:** no provider key or provider endpoint in the browser bundle, even as an optional mode.

**Why:** a key in an extension is extractable; a BYOK path would also require a broad host permission and invite accidental production use. Local development uses the mock provider server-side.

### 6. IndexedDB for jobs, `chrome.storage.local` for settings

**Why:** jobs can hold thousands of rows and full evidence; IndexedDB handles size and indexed reads. Settings stay small and synchronous. The MV3 worker is treated as disposable: rows are checkpointed per batch, interrupted lookups recover to `PENDING`, and alarms resume work.

### 7. Write rows before lookups

**Why:** a crash between the two writes must not mark a lookup resolved while its rows are stuck. Rows-first means recovery re-queues the lookup and recomputes the same decision; idempotency makes the retry safe.

### 8. Conservative provider pacing

- max 25 lookups per request (UI default 5, configurable 1–10);
- max 4 queries per lookup;
- sequential queries per lookup, bounded provider concurrency (default 2);
- 3 retry attempts with jitter for 429/5xx/timeouts, honoring `Retry-After`;
- a long rate-limit window pauses the job and auto-resumes at the reported time.

**Rejected:** unbounded parallelism, infinite retries, and “retry until green”.

### 9. Human override is explicit and labeled

Accepting an **excluded** candidate is possible only through an “Accept anyway” confirmation. The row becomes `USER_CONFIRMED`, not `MATCHED`; the audit trail and exports record the human decision. This keeps the automatic rule honest while allowing legitimate legal/trading-name exceptions.

### 10. Minimal permission surface and no remote code

`storage`, `alarms`, `downloads`, and one build-time resolver host. No content scripts, `tabs`, `activeTab`, `scripting`, `<all_urls>`, or LinkedIn host. All JS is bundled; CSP restricts scripts to self. The endpoint is baked at build time so the manifest can stay narrow.

### 11. Person mode reuses the evidence engine, not a second pipeline

**Decision:** add `/in/<slug>` URL validation, person-name normalization/title extraction, a person query planner, and a person evaluator in the same pure matching package. The job engine persists one mode per batch and dispatches evaluation by kind.

**Why:** resume, dedupe, review, audit, and exports stay identical. A second pipeline would duplicate state and drift.

**Rule:** people auto-match only with an exact name and a supplied company/title/location in the evidence; a name-only person batch is review-only. This is stricter than company matching on purpose because person names are rarely unique.

### 12. BYOK AI is query assistance, never URL generation

**Decision:** support Gemini, xAI Grok, and OpenRouter with keys pasted into Settings and stored locally. AI proposes at most two `site:linkedin.com/in/` queries per batch. The extension and resolver validate that each query contains the exact person name, starts with the profile-site restriction, and contains no URL/profile slug. AI failure sets a visible batch note and falls back to deterministic queries.

**Why:** the user asked for free/paid AI provider flexibility without weakening the accuracy contract. AI can improve recall for name/company variants, but an LLM must not invent or rank a URL.

**Trade-off:** keys in `chrome.storage.local` are readable by anyone with profile access; this is disclosed in Settings and PRIVACY. AI provider hosts are optional permissions, so the default install surface stays three API permissions plus one resolver host.

## Deviations / notes

- Store ZIPs are **unconfigured QA artifacts** because no resolver deployment or owner-provided origin exists. `tools/package-extension.mjs` refuses to create store-ready packages with `resolver.example.com`.
- GitHub credentials were not available (`gh auth status` showed no login). The repository is initialized and committed locally; no push, remote, release, or store submission is claimed.
- The reference implementation is single-instance; the README and SECURITY.md state the shared-store limitation.

## Open owner actions

1. Deploy the resolver over HTTPS with a Brave key and access tokens.
2. Rebuild with `RESOLVER_ORIGIN`, package, and record hashes.
3. Publish a privacy policy and support contact.
4. Authenticate GitHub, create/push the repository, and verify the commit SHA.
5. Obtain store accounts, reviewer token, final assets, and explicit submission authorization.
