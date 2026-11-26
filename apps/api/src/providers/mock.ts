import { fixtureResultsFor } from "@clf/fixtures";
import type { RawSearchResult } from "@clf/matching";
import type { SearchContext, SearchProvider } from "./types.js";

/**
 * Offline provider for local development and the deterministic demo.
 * It only returns sanitized fixture data; it cannot reach the network and it
 * refuses to invent a company page for an unknown name.
 */
export class MockSearchProvider implements SearchProvider {
  public readonly name = "mock";

  public async search(query: string, context: SearchContext): Promise<RawSearchResult[]> {
    const phrase = /"([^"]+)"/.exec(query)?.[1]?.trim() ?? "";
    if (!phrase) return [];
    return fixtureResultsFor(phrase, query, context.shape, context.retrievedAt).map((result) => ({
      ...result,
      provider: this.name,
    }));
  }
}
