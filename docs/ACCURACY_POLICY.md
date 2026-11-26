# Accuracy policy

This document is the normative description of how Company Page Finder decides whether to show a LinkedIn company page URL. The implementation lives in `packages/matching/src`, and the unit tests encode these rules.

## 1. The promise

The product guarantees that it will **not invent a URL**. Every selected URL:

1. was returned verbatim by the configured search provider for a company-restricted query;
2. passed strict URL parsing and canonicalization;
3. is backed by exactly one provider-returned candidate that satisfies the automatic rules;
4. has its evidence (title, snippet, queries, timestamps) stored with the row.

The product does **not** promise that every company name resolves, or that an evidence-backed match is what the user meant. Names are ambiguous; the tool returns review or not-found instead of guessing.

## 2. URL acceptance

Only `http:` or `https:` URLs are considered.

Accepted host: exactly `linkedin.com`, or a hostname ending in `.linkedin.com` (locale subdomains such as `uk.linkedin.com` are allowed).

Accepted path: exactly

```text
/company/<slug>
```

with an optional final slash. Everything else is rejected:

- people profiles (`/in/`), jobs, schools, groups, posts, events, showcase pages, search pages;
- `/company/<slug>/life`, `/company/<slug>/about`, or any extra segment;
- empty slugs, `..`, dots in slugs, encoded slashes/backslashes, credentials in the URL, non-default ports, backslashes;
- lookalike domains (`linkedin.com.evil.example`, `evil-linkedin.com`), shorteners (`lnkd.in`, `bit.ly`), redirectors;
- non-HTTP protocols, malformed percent-encoding.

A valid slug is 1–100 characters of Unicode letters/numbers plus `_` and `-`, starting with a letter/number, and containing no `.`, `%`, `/`, or `\`.

Query strings and fragments are stripped **after** validation. The canonical form is

```text
https://www.linkedin.com/company/<discovered-slug>/
```

This is normalization of an already-discovered URL. It is never constructed from a name. `assertSelectedUrlWasDiscovered` enforces that a selected URL is one of the evaluated candidates.

## 3. Name normalization

Both the input and the provider title entity are normalized before comparison:

1. Unicode NFKD; combining marks removed; lowercase.
2. Curly quotes and dashes normalized; `&` becomes `and`.
3. Every run of characters that is not a Unicode letter or number becomes a space. This preserves non-Latin scripts.
4. Leading/trailing whitespace removed; internal whitespace collapsed.

Trailing legal-form tokens are removed for the **comparison form only**. The raw input is always preserved for audit and export. Examples: `Acme Pvt. Ltd.` → `acme`; `Example Private Limited` → `example`; `Acme GmbH & Co. KG` → `acme`. A name is never reduced to nothing.

The provider title is reduced to its entity portion first by removing decorations such as `| LinkedIn`, `- LinkedIn`, `on LinkedIn`, and trailing descriptor clauses split by `|`, `–`, `—`, or `-`.

## 4. Query planning

Every query includes the restriction `site:linkedin.com/company/`. The exact company name is quoted. Optional facts only narrow the query:

| Shape      | Example                                             | When                                     |
| ---------- | --------------------------------------------------- | ---------------------------------------- |
| `primary`  | `site:linkedin.com/company/ "Acme Corp"`            | Always                                   |
| `alias`    | `site:linkedin.com/company/ "Acme Labs"`            | Alias differs from the name              |
| `domain`   | `site:linkedin.com/company/ "Acme Corp" "acme.com"` | Domain/website supplied                  |
| `country`  | `site:linkedin.com/company/ "Acme Corp" "India"`    | Country supplied                         |
| `reshaped` | `"Acme Corp" site:linkedin.com/company/`            | Short/generic name, or no domain/country |

Limits: four queries per lookup, 120-character sanitized phrase, 400-character query, no duplicate query strings, quotes/backslashes/control characters removed. The resolver rejects any candidate whose query does not contain the company-site restriction.

## 5. Candidate evaluation

For each distinct canonical URL:

- **Title match** — true only when the normalized title entity equals the normalized company name (or the supplied alias) exactly, including suffix removal. Prefix or fuzzy title matches do not auto-select.
- **Domain mentioned** — the supplied domain appears as a real host in the title/snippet, not as a substring (`microsoft.com` does not match `notmicrosoft.com` or `microsoft.com.evil`).
- **Country mentioned** — a known spelling/alias of the supplied country appears as a whole phrase. Collision-prone two-letter codes (e.g. “us” as a pronoun) are not treated as country evidence.
- **City mentioned** — whole-phrase match; corroboration only.
- **Second query** — the same canonical URL appears under two distinct query strings with two distinct shapes.
- **Slug/name overlap** — Dice coefficient used for ordering and audit only. It can **never** cause selection.
- **Plausible competitors** — candidates whose normalized title matches the name exactly. The count must be exactly one for an automatic match.

A candidate is `excluded` if its title does not match exactly. A candidate that matches exactly is `review` when the name requires corroboration and none is present; otherwise it is `selectable`.

### When is corroboration required?

A name is treated as short, generic, or commonly shared when any of these is true:

- the core name (after suffix removal) has one token or fewer (“Microsoft”, “Acme”);
- the core name is four characters or shorter;
- every token is a generic business word (“Global Solutions”);
- the core name is in a curated ambiguous list (“Acme”, “Apex”, “Summit”, …).

For such a name, an exact match must also have at least one of: supplied domain mentioned, supplied country mentioned, supplied city mentioned, or a second differently shaped query returning the same canonical URL.

## 6. Automatic decision

`MATCHED` requires all of:

1. at least one valid candidate;
2. **exactly one** candidate with an exact normalized title match;
3. that candidate is `selectable` (corroboration satisfied if required);
4. no second exact candidate;
5. the selected URL is one of the validated candidates.

That is deliberately strict. If any condition fails:

- `REVIEW_REQUIRED` when valid candidate URLs exist but the rules cannot choose (multiple exact candidates, no exact title, missing corroboration, all candidates rejected by the user);
- `NOT_FOUND` when the search completed and returned **no** valid `/company/` URL at all.

`ERROR` is produced by the job engine when the resolver/provider/network/validation fails after retry policy. A failure never becomes a match.

## 7. Human review

The review drawer lists every provider-returned candidate with its canonical URL, original provider URL, title, snippets, queries, signals, rule notes, and the final rule decision.

- **Accept** records `USER_CONFIRMED`, the selected URL, the operator name, and a timestamp in the local audit trail. A candidate that the automatic rules excluded (e.g. title mismatch) can be accepted only after an explicit “Accept anyway” confirmation; this is a human override and is labeled as such in the export.
- **Reject** records the rejection. If the rejected URL was the selected one, the row becomes `REVIEW_REQUIRED` with no selected URL; the candidate remains visible with “Rejected by you”.

A human confirmation is not presented as an automatic match. Exports distinguish `MATCHED` from `USER_CONFIRMED`.

## 8. What can still go wrong

### False positives (a wrong URL is selected)

Even with exact normalized names, a provider may return one page for a different company with the same name, or the intended company may share a name with a larger entity. The corroboration rule reduces this for short names but cannot eliminate it. Treat `MATCHED` as a strong candidate to verify, not a legal identity assertion.

### False negatives (a correct page is not selected)

- The page title uses a different brand, language, punctuation, or legal form not covered by the suffix list.
- A locale/title variant differs by a meaningful token (“Acme Corp India” for an input of “Acme Corp”).
- The provider does not index the page, or its index is stale.
- The domain/country is absent from the snippet, so corroboration fails.
- Non-Latin slugs are percent-encoded in a way that is rejected by the strict parser.

In these cases the tool returns review or not-found. That is the intended direction of error.

### Operational limits

- A user-supplied alias or domain can be wrong; the tool records it and uses it as evidence, but cannot verify it.
- Provider rate limits and terms change. The resolver surfaces 429/5xx and pauses instead of evading limits.
- Client/server clock skew affects displayed timestamps, not decisions.

## 9. Invariants enforced by tests

- No test and no production branch constructs a LinkedIn URL from a company name.
- A selected URL is always derived from a candidate discovered in provider results.
- Two exact candidates never auto-select.
- A profile/job/school/lookalike URL never becomes a candidate.
- A provider error never becomes a match.
- Exports preserve every original row, including errors and not-found rows.
- Human decisions are audit-logged with actor and time.

See `packages/matching/test`, `apps/extension/test`, and `apps/api/test`.
