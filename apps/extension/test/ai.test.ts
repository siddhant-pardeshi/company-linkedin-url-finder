import { describe, expect, it } from "vitest";
import { AiClient } from "../src/ai/client.js";
import { DEFAULT_AI_SETTINGS, hasUsableAiKey, maskApiKey, validateAiSettings } from "../src/ai/settings.js";

const SETTINGS = {
  enabled: true,
  provider: "gemini" as const,
  apiKey: "test-ai-key-123456",
  model: "gemini-3.5-flash-lite",
};

const ITEM = {
  lookupKey: "person-key",
  input: { kind: "person" as const, fullName: "Ada Lovelace", company: "Analytical Engines" },
};

const QUERY = 'site:linkedin.com/in/ "Ada Lovelace" "Analytical Engines"';

function geminiResponse(queries: string[]): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ results: [{ id: "0", queries }] }) }] } }],
    }),
    { status: 200 },
  );
}

describe("AI settings", () => {
  it("validates keys, providers, and models", () => {
    const valid = validateAiSettings(SETTINGS);
    expect(valid.ok).toBe(true);
    expect(validateAiSettings({ ...SETTINGS, enabled: false, apiKey: "" }).ok).toBe(true);
    expect(validateAiSettings({ ...SETTINGS, enabled: true, apiKey: "" }).ok).toBe(false);
    expect(validateAiSettings({ ...SETTINGS, provider: "other" }).ok).toBe(false);
    expect(validateAiSettings({ ...SETTINGS, model: "bad model" }).ok).toBe(false);
    expect(validateAiSettings({ ...SETTINGS, apiKey: "has space 1234" }).ok).toBe(false);
  });

  it("defaults, masks, and checks usability", () => {
    expect(DEFAULT_AI_SETTINGS.provider).toBe("gemini");
    expect(hasUsableAiKey(SETTINGS)).toBe(true);
    expect(hasUsableAiKey({ ...SETTINGS, apiKey: "" })).toBe(false);
    expect(maskApiKey("abcdefghijklmnop")).toBe("••••mnop");
  });
});

describe("AiClient", () => {
  it("calls Gemini with a header key and returns validated queries", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const client = new AiClient({
      settings: SETTINGS,
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenInit = init;
        return geminiResponse([QUERY]);
      },
    });
    const result = await client.generateQueries([ITEM]);
    expect(seenUrl).toContain("generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite");
    expect(seenInit?.headers).toMatchObject({ "x-goog-api-key": SETTINGS.apiKey });
    expect(JSON.parse(String(seenInit?.body))).toMatchObject({ contents: [{ role: "user" }] });
    expect(result["person-key"]).toEqual([QUERY]);
  });

  it("supports xAI and OpenRouter chat-completions shapes", async () => {
    for (const provider of ["xai", "openrouter"] as const) {
      let seenUrl = "";
      const client = new AiClient({
        settings: { ...SETTINGS, provider, model: provider === "xai" ? "grok-4.5" : "openrouter/auto" },
        fetchImpl: async (url, init) => {
          seenUrl = url;
          expect(init?.headers).toMatchObject({ Authorization: `Bearer ${SETTINGS.apiKey}` });
          return new Response(
            JSON.stringify({
              choices: [
                { message: { content: JSON.stringify({ results: [{ id: "0", queries: [QUERY] }] }) } },
              ],
            }),
            { status: 200 },
          );
        },
      });
      const result = await client.generateQueries([ITEM]);
      expect(seenUrl).toContain(provider === "xai" ? "api.x.ai" : "openrouter.ai");
      expect(result["person-key"]).toEqual([QUERY]);
    }
  });

  it("drops profile URLs, wrong-name queries, and duplicate queries", async () => {
    const client = new AiClient({
      settings: SETTINGS,
      fetchImpl: async () =>
        geminiResponse([
          "https://www.linkedin.com/in/ada-lovelace/",
          'site:linkedin.com/in/ "Grace Hopper"',
          QUERY,
          QUERY,
        ]),
    });
    const result = await client.generateQueries([ITEM]);
    expect(result["person-key"]).toEqual([QUERY]);
  });

  it("maps auth, rate-limit, and malformed responses to safe errors", async () => {
    const unauthorized = new AiClient({
      settings: SETTINGS,
      fetchImpl: async () => new Response("{}", { status: 401 }),
    });
    await expect(unauthorized.generateQueries([ITEM])).rejects.toMatchObject({ code: "ai_auth_failed" });

    const limited = new AiClient({
      settings: SETTINGS,
      fetchImpl: async () => new Response("{}", { status: 429 }),
    });
    await expect(limited.generateQueries([ITEM])).rejects.toMatchObject({ code: "ai_rate_limited" });

    const malformed = new AiClient({
      settings: SETTINGS,
      fetchImpl: async () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }), {
          status: 200,
        }),
    });
    await expect(malformed.generateQueries([ITEM])).rejects.toMatchObject({ code: "ai_bad_response" });
  });

  it("requires a key and verifies the connection", async () => {
    const missing = new AiClient({ settings: { ...SETTINGS, apiKey: "" } });
    await expect(missing.generateQueries([ITEM])).rejects.toMatchObject({ code: "ai_missing_key" });

    const healthy = new AiClient({
      settings: SETTINGS,
      fetchImpl: async () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), {
          status: 200,
        }),
    });
    await expect(healthy.testConnection()).resolves.toMatchObject({ ok: true, provider: "gemini" });
  });
});
