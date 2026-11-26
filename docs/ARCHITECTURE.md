# Architecture

Company Page Finder is two deployable pieces and one shared pure library:

1. **Extension** — a Manifest V3 workspace that owns input, job state, deterministic decisions, review, audit, and export.
2. **Resolver** — a small HTTPS service that owns the licensed search-provider credential and returns only structured evidence.
3. **Matching** — a pure TypeScript package shared by both (the resolver uses query planning; the extension uses the full rule engine).

The split is deliberate: the browser never holds a paid provider key, and the server never decides which company a URL belongs to. The evidence and the rules live together in the client, so a review can be reproduced from stored data.

## Data flow

```text
┌──────────────────────────── Extension (MV3) ────────────────────────────┐
│                                                                        │
│  workspace.html                                                         │
│    paste / CSV ──► import validation ──► job:start                       │
│                                              │                          │
│  service worker (disposable)                 ▼                          │
│    JobEngine ──► IndexedDB: jobs, rows, lookups, audit                  │
│        │   ▲                                                            │
│        │   └── checkpoint / recover after sleep                         │
│        ▼                                                                │
│    ResolverClient ── HTTPS + bearer token ──┐                           │
│        │                                    │                           │
│        ▼                                    │                           │
│    evaluateLookup (pure) ◄── evidence ──────┼─────────────┐             │
│        │                                    │             │             │
│        ▼                                    │             │             │
│    MATCHED / REVIEW / NOT_FOUND             │             │             │
│        │                                    │             │             │
│  review drawer ── accept/reject ── audit     │             │             │
│  CSV / JSON export ◄─────────────────────────┘             │             │
└────────────────────────────────────────────────────────────┼─────────────┘
                                                             │
┌──────────────────────────── Resolver (Node) ───────────────▼─────────────┐
│  POST /v1/search                                                        │
│    auth ─► rate limit ─► schema validation ─► idempotency cache         │
│        │                                                                │
│        ▼                                                                │
│    query planner ─► provider adapter (Brave / mock)                     │
│        │                │                                               │
│        │                └── retry + backoff + concurrency semaphore     │
│        ▼                                                                │
│    verbatim results (title, URL, snippet, query, timestamp)             │
│                                                                        │
│  GET /v1/whoami (connection test)   GET /healthz                        │
└────────────────────────────────────────────────────────────────────────┘
```

## Why the server does not decide matches

“Which company does this page belong to?” is a product judgment that must be explainable and reproducible. Keeping it in the extension means:

- every decision can be recomputed from the stored provider evidence;
- the rules are the same code that unit tests exercise;
- the server is a narrow, replaceable search proxy with a small attack surface;
- no company names or decisions are required to persist server-side.

The server still validates input, plans queries, bounds cost, and never returns a URL that it constructed.

## Components

### `packages/matching` (pure)

| Module          | Responsibility                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `url.ts`        | Strict parser for `linkedin.com/company/<slug>`; canonicalization of discovered URLs only.                              |
| `normalize.ts`  | Unicode/case/punctuation normalization, legal-suffix removal, domains, countries, title entity extraction, de-dup keys. |
| `query.ts`      | Conservative query planner, query sanitization, company-site restriction checks.                                        |
| `evaluate.ts`   | Candidate grouping, deterministic signals, verdicts, decision, explanation codes.                                       |
| `api-schema.ts` | Shared request/response validation for the resolver contract.                                                           |
| `labels.ts`     | Status/query/reason labels used by the UI and exports.                                                                  |

No network, no DOM, no clocks, no randomness, no AI. The same inputs always produce the same output.

### `apps/api`

- Node HTTP server, zero runtime web framework.
- Bearer auth with constant-time digest comparison; tokens are never stored or logged in raw form.
- Per-token token-bucket rate limiting.
- Body limit (64 KiB), lookup limit (25), strict JSON schema, 90 s request ceiling, 50 s batch budget.
- Provider-aware retries (3 attempts, jittered exponential backoff) only for retryable errors. A `Retry-After` longer than the retry ceiling is surfaced instead of ignored.
- Bounded provider concurrency (default 2).
- Idempotency cache bound to a fingerprint of the request payload; a reused key with a different payload is `409`.
- No persistence of lookups. Only a TTL idempotency cache in memory.
- Structured logs contain request IDs, status, counts, and latency — not names, queries, URLs, or tokens.

Endpoints:

| Method | Path         | Auth | Purpose                                              |
| ------ | ------------ | ---- | ---------------------------------------------------- |
| `GET`  | `/healthz`   | No   | Liveness, version, provider name.                    |
| `GET`  | `/v1/whoami` | Yes  | Connection test; returns service, version, provider. |
| `POST` | `/v1/search` | Yes  | Small batch of lookups → verbatim evidence.          |

### `apps/extension`

| Area                           | Responsibility                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `background/service-worker.ts` | Message router, alarms, startup recovery, toolbar launcher.                                    |
| `job/engine.ts`                | Durable queue, batching, pause/resume/cancel, retries, context updates, user decisions, audit. |
| `storage/repository.ts`        | Storage interface + in-memory implementation for tests.                                        |
| `storage/idb.ts`               | IndexedDB implementation (jobs, rows, lookups, audit).                                         |
| `api/client.ts`                | Authenticated fetch, timeout, HTTP error mapping, response schema validation.                  |
| `ui/*`                         | Accessible full-page workspace, review drawer, CSV/JSON, options.                              |
| `settings.ts`                  | Settings defaults and pure validation.                                                         |

## Job lifecycle and MV3 durability

The service worker is disposable. Correctness relies on **checkpointing**, not on staying alive.

```text
createJob ──► PENDING rows/lookups
                 │
                 ▼
           job state = running
                 │
      ┌──────────┴──────────┐
      │  batch (N lookups)  │
      │  mark IN_PROGRESS   │
      │  call resolver      │
      │  evaluate + persist │
      └──────────┬──────────┘
                 │
    ┌────────────┼─────────────┬──────────────┐
    ▼            ▼             ▼              ▼
 completed     paused        cancelled      error batch
 (no pending)  (user/auth/   (terminal)     (rows ERROR,
                rate/network)                job paused)
```

- At the start of `run`, `IN_PROGRESS` lookups and rows are reset to `PENDING` (crash recovery).
- Results are written **rows first, lookups second**. A crash in between leaves the lookup `IN_PROGRESS`, which recovery re-queues; a row cannot be stranded.
- Idempotency keys are `sha256(jobId + sorted lookup keys)`. A retried batch reuses the key, so a successful provider call is never paid for twice.
- `chrome.alarms` wakes the worker while a job is running and at a rate-limit cooldown. A 1-minute tick is a safety net, not the primary driver.
- Closing the workspace, reloading the extension, or a worker shutdown does not lose job state; reopening reads the latest snapshot from IndexedDB.
- Pause/cancel are persisted flags checked between batches; an in-flight request is allowed to finish and its evidence is kept.
- Rate-limit pauses store `cooldownUntil`; the alarm auto-resumes after the provider delay. Network/auth pauses require an operator action.

## Storage schema (IndexedDB v1)

Database: `companyPageFinder`

| Store     | Key                     | Indexes                                    | Contents                                                                                         |
| --------- | ----------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `jobs`    | `id`                    | —                                          | Job state, counts, batch size, operator, pause/cooldown metadata.                                |
| `rows`    | `id` (`jobId:rowIndex`) | `jobId`, `jobId_status`, `jobId_lookupKey` | Original input row, lookup key, status, selected URL, full evaluation, confirmation, rejections. |
| `lookups` | `key` (`jobId           | lookupKey`)                                | `jobId`, `jobId_status`                                                                          | Representative input, planned queries, evaluation or error. |
| `audit`   | `id`                    | `jobId`                                    | Job and human-decision audit entries.                                                            |

`chrome.storage.local` holds only settings (`accessToken`, operator name, batch size, retention days). Jobs never go there.

## Resolver contract

Request:

```json
{
  "schemaVersion": 1,
  "idempotencyKey": "a-64-char-hex-digest",
  "lookups": [
    {
      "id": "l0",
      "companyName": "Example Private Ltd",
      "country": "India",
      "officialDomain": "example.in",
      "alias": "Example Pvt Ltd"
    }
  ]
}
```

Response (abridged):

```json
{
  "schemaVersion": 1,
  "provider": "brave",
  "generatedAt": "2026-11-26T10:00:00.000Z",
  "results": [
    {
      "id": "l0",
      "queries": [
        {
          "query": "site:linkedin.com/company/ \"Example Private Ltd\" \"example.in\"",
          "shape": "domain",
          "rationale": "Adds the supplied official domain as a narrowing constraint."
        }
      ],
      "results": [
        {
          "originalUrl": "https://in.linkedin.com/company/example-private-limited",
          "title": "Example Private Limited | LinkedIn",
          "snippet": "Software Development. Pune, Maharashtra. example.in",
          "provider": "brave",
          "query": "site:linkedin.com/company/ \"Example Private Ltd\" \"example.in\"",
          "shape": "domain",
          "retrievedAt": "2026-11-26T10:00:00.000Z"
        }
      ],
      "errors": [],
      "cached": false
    }
  ]
}
```

Error responses use `{ "error": { "code", "message", "retryable", "requestId" } }` and never include secrets, names, or query text.

## Threat model and trust boundaries

| Threat                                       | Mitigation                                                                                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider key theft from a public extension   | Key exists only in the resolver secret store. The bundle contains no provider key or endpoint.                                                                   |
| Shared static endpoint secret                | Per-user bearer tokens (hashed at rest in memory), quotas, rate limits, HTTPS requirement.                                                                       |
| Malicious provider result / lookalike domain | Exact host allowlist (`linkedin.com` or `*.linkedin.com`), exact `/company/<slug>` path, rejected credentials/ports/encodings/lookalikes, no redirect following. |
| Fabricated URL by code                       | Selection is a reference to a validated candidate; an invariant assertion rejects any selection not backed by a candidate.                                       |
| XSS from provider titles/snippets            | All provider text is rendered with `textContent`; links are restricted to canonical `https://www.linkedin.com/company/…`; no `innerHTML` with data.              |
| CSRF/abuse of the resolver                   | JSON + `Authorization` header (preflight for browsers), bearer token, rate limit, body limit, optional origin allowlist.                                         |
| Log leakage                                  | Logs exclude names, URLs, queries, tokens, and payloads.                                                                                                         |
| Extension compromise                         | Narrow permissions, no content scripts, no remote code, restrictive CSP.                                                                                         |
| Data at rest on a shared computer            | Settings token and job data are local to the browser profile; delete-all in Settings; retention defaults to 30 days.                                             |

## Provider adapter model

```ts
interface SearchProvider {
  name: string;
  search(query: string, context: { shape; retrievedAt }): Promise<RawSearchResult[]>;
}
```

`BraveSearchProvider` maps HTTP status to typed retryable/non-retryable failures, enforces a timeout, strips everything except title/URL/snippet, and never logs the query. `MockSearchProvider` returns only sanitized fixtures and refuses unknown companies. A second provider can be added without touching the matching rules; the resolver returns the provider name and the extension stores it with each result.

## Design trade-offs

- **Client-side rules** keep evidence auditable and the server replaceable; the cost is a larger client bundle (still well under 1 MB).
- **Conservative matching** sends more rows to review than a fuzzy matcher would. That is the intended trade-off.
- **In-memory server controls** keep the reference deployment simple and privacy-friendly. Horizontal scale needs a shared rate-limit/idempotency store; documented as a limitation.
- **Single active workspace job** keeps resumption understandable. All rows from the batch are preserved; the latest job is shown, older jobs are retained until cleanup.
