export type AiProvider = "gemini" | "xai" | "openrouter";

export type AiSettings = {
  enabled: boolean;
  provider: AiProvider;
  apiKey: string;
  model: string;
};

export type AiProviderInfo = {
  id: AiProvider;
  label: string;
  origin: string;
  endpoint: string;
  defaultModel: string;
  modelPlaceholder: string;
  note: string;
};

export const AI_PROVIDERS: Record<AiProvider, AiProviderInfo> = {
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    origin: "https://generativelanguage.googleapis.com/*",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    defaultModel: "gemini-3.5-flash-lite",
    modelPlaceholder: "gemini-3.5-flash-lite",
    note: "Uses the Gemini API key from Google AI Studio. Free-tier availability and quotas depend on your Google project.",
  },
  xai: {
    id: "xai",
    label: "xAI Grok",
    origin: "https://api.x.ai/*",
    endpoint: "https://api.x.ai/v1/chat/completions",
    defaultModel: "grok-4.5",
    modelPlaceholder: "grok-4.5",
    note: "Uses an xAI API key and model ID. xAI may require a paid plan; confirm current pricing.",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    origin: "https://openrouter.ai/*",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "openrouter/auto",
    modelPlaceholder: "openrouter/auto or a :free model slug",
    note: "One key for many models, including free model slugs. Availability and rate limits depend on OpenRouter.",
  },
};

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  provider: "gemini",
  apiKey: "",
  model: AI_PROVIDERS.gemini.defaultModel,
};

export type AiSettingsValidation = { ok: true; settings: AiSettings } | { ok: false; errors: string[] };

const STORAGE_KEY = "companyPageFinder.ai.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAiProvider(value: unknown): value is AiProvider {
  return value === "gemini" || value === "xai" || value === "openrouter";
}

export function validateAiSettings(
  input: unknown,
  fallback: AiSettings = DEFAULT_AI_SETTINGS,
): AiSettingsValidation {
  if (!isRecord(input)) return { ok: false, errors: ["AI settings must be an object."] };
  const errors: string[] = [];
  let provider = fallback.provider;
  if (input["provider"] !== undefined) {
    if (isAiProvider(input["provider"])) provider = input["provider"];
    else errors.push("Unsupported AI provider.");
  }
  const enabled = typeof input["enabled"] === "boolean" ? input["enabled"] : fallback.enabled;
  const apiKey = typeof input["apiKey"] === "string" ? input["apiKey"].trim() : fallback.apiKey;
  const modelRaw = typeof input["model"] === "string" ? input["model"].trim() : fallback.model;
  const model = modelRaw || AI_PROVIDERS[provider].defaultModel;

  if (enabled && apiKey.length < 8)
    errors.push("An API key of at least 8 characters is required when AI assist is enabled.");
  if (/\s/.test(apiKey)) errors.push("API keys must not contain spaces.");
  if (apiKey.length > 512) errors.push("API key is too long.");
  if (!/^[^\s\u0000-\u001f\u007f]{1,160}$/.test(model)) errors.push("Model ID is invalid.");

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, settings: { enabled, provider, apiKey, model } };
}

export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

export function hasUsableAiKey(settings: AiSettings): boolean {
  return settings.apiKey.trim().length >= 8 && !/\s/.test(settings.apiKey);
}

function storageGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (items) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message ?? "Could not read AI settings."));
      else resolve(items[key] as T | undefined);
    });
  });
}

function storageSet(key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message ?? "Could not save AI settings."));
      else resolve();
    });
  });
}

export async function loadAiSettings(): Promise<AiSettings> {
  try {
    const stored = await storageGet<unknown>(STORAGE_KEY);
    if (!isRecord(stored)) return { ...DEFAULT_AI_SETTINGS };
    const validated = validateAiSettings({ ...DEFAULT_AI_SETTINGS, ...stored }, DEFAULT_AI_SETTINGS);
    return validated.ok ? validated.settings : { ...DEFAULT_AI_SETTINGS };
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

export async function saveAiSettings(patch: Partial<AiSettings>): Promise<AiSettings> {
  const current = await loadAiSettings();
  const validated = validateAiSettings({ ...current, ...patch }, current);
  if (!validated.ok) throw new Error(validated.errors.join(" "));
  await storageSet(STORAGE_KEY, validated.settings);
  return validated.settings;
}

export async function clearAiSettings(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    chrome.storage.local.remove(STORAGE_KEY, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message ?? "Could not clear AI settings."));
      else resolve();
    });
  });
}
