import { normalizePersonName, sanitizePersonExtraQuery, type PersonInput } from "@clf/matching";
import { AI_PROVIDERS, type AiSettings } from "./settings.js";

export type AiQueryItem = {
  lookupKey: string;
  input: PersonInput;
};

export class AiError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AiError";
    this.code = code;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type AiClientOptions = {
  settings: AiSettings;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_BATCH = 10;

function extractJson(text: string): unknown {
  const cleaned = String(text ?? "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start)
    throw new AiError("ai_bad_response", "The AI provider returned no JSON object.");
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  } catch {
    throw new AiError("ai_bad_response", "The AI provider returned malformed JSON.");
  }
}

function buildPrompt(items: AiQueryItem[]): string {
  const payload = items.map((item, index) => ({
    id: String(index),
    full_name: item.input.fullName,
    company: item.input.company ?? "",
    job_title: item.input.jobTitle ?? "",
    location: item.input.location ?? "",
  }));
  return [
    "You generate conservative LinkedIn people-search queries.",
    'Return JSON only in this shape: {"results":[{"id":"0","queries":["..."]}]}',
    "Rules:",
    "- At most 2 queries per person.",
    "- Each query must start with site:linkedin.com/in/ and contain the exact full name in double quotes.",
    "- Use only the supplied facts; you may add a different spelling of the company or job title if it is a synonym.",
    "- Never output a LinkedIn profile URL, guessed profile slug, email, phone, or markdown.",
    "- If there is no useful alternate query, return an empty queries array for that person.",
    "People:",
    JSON.stringify(payload),
  ].join("\n");
}

/**
 * BYOK AI query assistant. It only proposes site-restricted search queries;
 * it never returns a profile URL and never selects a candidate. Keys are held
 * in chrome.storage.local and sent only to the selected AI provider.
 */
export class AiClient {
  private readonly settings: AiSettings;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: AiClientOptions) {
    this.settings = options.settings;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async post(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut || (error instanceof Error && error.name === "AbortError")) {
        throw new AiError("ai_timeout", "The AI provider did not answer in time.");
      }
      throw new AiError("ai_network", "The AI provider could not be reached.");
    } finally {
      clearTimeout(timer);
    }
  }

  private async call(prompt: string): Promise<string> {
    const { provider, apiKey, model } = this.settings;
    if (!apiKey) throw new AiError("ai_missing_key", "No AI API key is configured.");
    const info = AI_PROVIDERS[provider];

    let response: Response;
    if (provider === "gemini") {
      const modelPath = model.replace(/^models\//, "");
      response = await this.post(
        `${info.endpoint}/${encodeURIComponent(modelPath)}:generateContent`,
        { "x-goog-api-key": apiKey },
        {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
        },
      );
    } else {
      response = await this.post(
        info.endpoint,
        { Authorization: `Bearer ${apiKey}` },
        {
          model,
          messages: [
            { role: "system", content: "You return strict JSON only, with no markdown." },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          stream: false,
        },
      );
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AiError("ai_auth_failed", "The AI provider rejected the API key.");
      }
      if (response.status === 429) {
        throw new AiError("ai_rate_limited", "The AI provider rate limit was reached.");
      }
      if (response.status >= 500) {
        throw new AiError("ai_unavailable", "The AI provider is temporarily unavailable.");
      }
      throw new AiError("ai_bad_response", `The AI provider rejected the request (HTTP ${response.status}).`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AiError("ai_bad_response", "The AI provider returned a non-JSON response.");
    }

    if (provider === "gemini") {
      const candidate = (
        payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> }
      ).candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text;
      if (typeof text !== "string" || !text.trim()) {
        throw new AiError("ai_bad_response", "The AI provider returned an empty response.");
      }
      return text;
    }

    const text = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message
      ?.content;
    if (typeof text !== "string" || !text.trim()) {
      throw new AiError("ai_bad_response", "The AI provider returned an empty response.");
    }
    return text;
  }

  public async testConnection(): Promise<{ ok: true; provider: string; model: string }> {
    const text = await this.call('Return exactly this JSON and nothing else: {"ok":true}');
    const parsed = extractJson(text) as { ok?: unknown };
    if (parsed.ok !== true) throw new AiError("ai_bad_response", "The AI provider did not confirm the test.");
    return { ok: true, provider: this.settings.provider, model: this.settings.model };
  }

  public async generateQueries(items: AiQueryItem[]): Promise<Record<string, string[]>> {
    const batch = items.slice(0, MAX_BATCH);
    if (batch.length === 0) return {};
    const text = await this.call(buildPrompt(batch));
    const parsed = extractJson(text) as { results?: unknown };
    if (!Array.isArray(parsed.results)) {
      throw new AiError("ai_bad_response", "The AI provider returned an unexpected query plan.");
    }

    const output: Record<string, string[]> = {};
    for (const entry of parsed.results) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as { id?: unknown; queries?: unknown };
      if (typeof record.id !== "string" || !Array.isArray(record.queries)) continue;
      const index = Number(record.id);
      const item = Number.isInteger(index) ? batch[index] : undefined;
      if (!item) continue;
      const name = normalizePersonName(item.input.fullName);
      const accepted: string[] = [];
      for (const query of record.queries.slice(0, 4)) {
        const cleaned = sanitizePersonExtraQuery(query, name);
        if (cleaned && !accepted.includes(cleaned)) accepted.push(cleaned);
        if (accepted.length >= 2) break;
      }
      if (accepted.length > 0) output[item.lookupKey] = accepted;
    }
    return output;
  }
}
