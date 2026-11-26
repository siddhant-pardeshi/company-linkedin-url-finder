import type { RawSearchResult } from "@clf/matching";

/**
 * Sanitized fake provider data. No real scraping, no LinkedIn access, no
 * personal data. These fixtures exist so the whole product can be tested and
 * demoed without a provider key or network access.
 */

export const FIXTURE_TIME = "2026-11-20T10:00:00.000Z";

export type FixtureResult = {
  url: string;
  title: string;
  snippet: string;
};

export type FixtureCompany = {
  companyName: string;
  results: FixtureResult[];
  note: string;
};

const MICROSOFT: FixtureCompany = {
  companyName: "Microsoft",
  note: "One exact candidate, domain corroboration.",
  results: [
    {
      url: "https://www.linkedin.com/company/microsoft/?trk=public_profile",
      title: "Microsoft | LinkedIn",
      snippet:
        "Microsoft. 24,392,101 followers. Technology, Information and Internet. Redmond, Washington. microsoft.com",
    },
  ],
};

const EXAMPLE: FixtureCompany = {
  companyName: "Example Private Ltd",
  note: "One exact candidate, legal suffix differs, domain corroboration.",
  results: [
    {
      url: "https://in.linkedin.com/company/example-private-limited",
      title: "Example Private Limited | LinkedIn",
      snippet: "Example Private Limited. Software Development. Pune, Maharashtra. example.in",
    },
  ],
};

const ACME: FixtureCompany = {
  companyName: "Acme",
  note: "Two exact candidates with unrelated businesses; must be review-required.",
  results: [
    {
      url: "https://www.linkedin.com/company/acme-inc",
      title: "Acme Inc. | LinkedIn",
      snippet: "Acme Inc. Industrial Machinery Manufacturing. United States.",
    },
    {
      url: "https://www.linkedin.com/company/acme-corporation",
      title: "Acme Corporation | LinkedIn",
      snippet: "Acme Corporation. IT Services and IT Consulting. India.",
    },
  ],
};

const UMBRELLA: FixtureCompany = {
  companyName: "Umbrella",
  note: "A valid company URL, but the title adds a qualifier; no exact match.",
  results: [
    {
      url: "https://www.linkedin.com/company/umbrella-group",
      title: "Umbrella Group | LinkedIn",
      snippet: "Umbrella Group. Business Consulting and Services. London, England.",
    },
  ],
};

const INERTECH: FixtureCompany = {
  companyName: "Initech",
  note: "Only a person profile and a jobs page are returned.",
  results: [
    {
      url: "https://www.linkedin.com/in/initech-founder",
      title: "Initech Founder - Founder - Initech | LinkedIn",
      snippet: "View Initech Founder's profile on LinkedIn.",
    },
    {
      url: "https://www.linkedin.com/jobs/initech-jobs",
      title: "Initech jobs | LinkedIn",
      snippet: "Search jobs at Initech.",
    },
  ],
};

export const FIXTURE_COMPANIES: readonly FixtureCompany[] = [MICROSOFT, EXAMPLE, ACME, UMBRELLA, INERTECH];

const byName = new Map(
  FIXTURE_COMPANIES.map((company) => [company.companyName.toLowerCase(), company] as const),
);

export function findFixtureCompany(companyName: string): FixtureCompany | undefined {
  return byName.get(companyName.trim().toLowerCase());
}

/** Build a provider-shaped result for tests / the local mock provider. */
export function fixtureResult(
  fixture: FixtureResult,
  query: string,
  shape: RawSearchResult["shape"],
  retrievedAt = FIXTURE_TIME,
): RawSearchResult {
  return {
    originalUrl: fixture.url,
    title: fixture.title,
    snippet: fixture.snippet,
    provider: "fixture",
    query,
    shape,
    retrievedAt,
  };
}

export function fixtureResultsFor(
  companyName: string,
  query: string,
  shape: RawSearchResult["shape"],
  retrievedAt = FIXTURE_TIME,
): RawSearchResult[] {
  const company = findFixtureCompany(companyName);
  if (!company) return [];
  return company.results.map((result) => fixtureResult(result, query, shape, retrievedAt));
}

/** Raw Brave-shaped JSON, for adapter tests. */
export const braveSuccessBody = {
  type: "search",
  web: {
    type: "search",
    results: [
      {
        title: "Microsoft | LinkedIn",
        url: "https://www.linkedin.com/company/microsoft/",
        description: "Microsoft. Technology, Information and Internet. Redmond, Washington. microsoft.com",
        profile: { name: "Microsoft" },
      },
    ],
  },
};

export const braveEmptyBody = { type: "search", web: { type: "search", results: [] } };

export const braveMalformedBody = { type: "search", web: { results: "not-an-array" } };

export const braveRateLimitBody = {
  type: "ErrorResponse",
  error: { code: "RATE_LIMITED", detail: "Request rate limit exceeded", status: 429 },
};

export const braveAuthErrorBody = {
  type: "ErrorResponse",
  error: { code: "SUBSCRIPTION_TOKEN_INVALID", detail: "The subscription token is invalid", status: 401 },
};

export const SAMPLE_CSV = `company_name,country,region,city,official_domain,official_website,alias,notes
Microsoft,United States,Washington,Redmond,microsoft.com,https://www.microsoft.com,,
Example Private Ltd,India,Maharashtra,Pune,example.in,https://example.in,Example Pvt Ltd,
Acme,,,,,,,
Umbrella,United Kingdom,,London,,,,
Initech,,,,,,,
`;

/** Sanitized person fixtures for the offline provider and tests. */
export type PersonFixture = {
  fullName: string;
  results: FixtureResult[];
  note: string;
};

const ADA: PersonFixture = {
  fullName: "Ada Lovelace",
  note: "One exact profile with employer, title, and location corroboration.",
  results: [
    {
      url: "https://www.linkedin.com/in/ada-lovelace/?trk=people",
      title: "Ada Lovelace - Mathematician - Analytical Engines | LinkedIn",
      snippet: "London, England · Analytical Engines · Mathematics",
    },
  ],
};

const GRACE: PersonFixture = {
  fullName: "Grace Hopper",
  note: "One exact profile with employer and title corroboration.",
  results: [
    {
      url: "https://www.linkedin.com/in/grace-hopper/",
      title: "Grace Hopper - Rear Admiral - United States Navy | LinkedIn",
      snippet: "Arlington, Virginia · United States Navy · Computer Science",
    },
  ],
};

const ALAN: PersonFixture = {
  fullName: "Alan Turing",
  note: "Two exact-name profiles; must be review-required.",
  results: [
    {
      url: "https://www.linkedin.com/in/alan-turing/",
      title: "Alan Turing - Mathematician | LinkedIn",
      snippet: "Bletchley, England · Bletchley Park",
    },
    {
      url: "https://www.linkedin.com/in/alan-turing-2/",
      title: "Alan Turing - Computer Scientist | LinkedIn",
      snippet: "Manchester, England · University of Manchester",
    },
  ],
};

const NOAH: PersonFixture = {
  fullName: "Noah Body",
  note: "No results; not-found demo.",
  results: [],
};

export const PERSON_FIXTURES: readonly PersonFixture[] = [ADA, GRACE, ALAN, NOAH];

const personByName = new Map(
  PERSON_FIXTURES.map((person) => [person.fullName.toLowerCase(), person] as const),
);

export function findPersonFixture(fullName: string): PersonFixture | undefined {
  return personByName.get(fullName.trim().toLowerCase());
}

export function personFixtureResultsFor(
  fullName: string,
  query: string,
  shape: RawSearchResult["shape"],
  retrievedAt = FIXTURE_TIME,
): RawSearchResult[] {
  const person = findPersonFixture(fullName);
  if (!person) return [];
  return person.results.map((result) => fixtureResult(result, query, shape, retrievedAt));
}

export const PEOPLE_SAMPLE_CSV = `full_name,company,job_title,location,email,phone,notes
Ada Lovelace,Analytical Engines,Mathematician,"London, England",ada@example.test,,
Grace Hopper,United States Navy,Rear Admiral,"Arlington, Virginia",,,
Alan Turing,Bletchley Park,Mathematician,"Bletchley, England",,,
Noah Body,,,,,,
`;
