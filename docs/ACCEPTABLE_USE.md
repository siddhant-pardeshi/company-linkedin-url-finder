# Acceptable use

Company Page Finder exists to find **public company page URLs** from licensed search-provider evidence for business research and data cleanup.

## Allowed

- Resolving company names you are entitled to process.
- Adding official domains, countries, or aliases to improve disambiguation.
- Reviewing candidates and recording human decisions locally.
- Exporting results for internal analysis, CRM cleanup, or vendor review.
- Self-hosting the resolver with your own provider credentials and terms.

## Not allowed

- **Scraping LinkedIn.** This project does not scrape, crawl, automate, or log in to LinkedIn. Do not modify it to do so.
- **Bypassing access controls.** No CAPTCHA solving, IP rotation, login walls, robots bypass, cookies from LinkedIn, or unofficial APIs.
- **Scraping search-engine result pages.** Use a licensed structured search API with terms that permit your use.
- **Using an LLM to invent or rank a URL.** The matching path must remain deterministic and evidence-backed.
- **Collecting personal profiles.** This tool is for company pages, not people.
- **Bulk abuse of the resolver.** No attempts to evade quotas, share a token publicly, or resell access without authorization.
- **Misrepresentation.** Do not claim LinkedIn affiliation, certification, or verification. “High-confidence match” means the deterministic evidence passed; it is not a LinkedIn attestation.
- **Unlawful processing.** Do not use the tool to violate sanctions, privacy law, contractual restrictions, or the search provider’s terms.
- **High-stakes automated decisions.** Do not use an unverified URL as the sole basis for a legal, financial, employment, or safety decision.

## Provider terms

You are responsible for:

- obtaining a valid search-provider plan and key;
- confirming that your queries, caching, display, and retention comply with the provider’s current terms;
- respecting rate limits (the resolver backs off and pauses instead of evading them);
- attributing provider data as required.

The reference adapter targets the [Brave Web Search API](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started). Its terms and availability can change; verify them before launch.

## LinkedIn

LinkedIn’s User Agreement and Prohibited Software and Extensions policy apply to LinkedIn usage. This project does not access LinkedIn, request a LinkedIn host permission, or automate the site. It only displays public URLs returned by a search provider. Consult LinkedIn’s current terms and your own legal counsel; this document is not legal advice.

## Enforcement

Deployments may revoke tokens, rate-limit, or refuse service for abuse. The software is provided under the MIT License without warranty; misuse is the operator’s responsibility.
