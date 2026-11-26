import type { AppSettings } from "./types.js";
import { DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE } from "./types.js";

export type SettingsValidation = { ok: true; settings: AppSettings } | { ok: false; errors: string[] };

export const DEFAULT_SETTINGS: AppSettings = {
  accessToken: "",
  operatorName: "Local user",
  batchSize: DEFAULT_BATCH_SIZE,
  retentionDays: 30,
};

const STORAGE_KEY = "companyPageFinder.settings.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pure validation, shared by the options page and the service worker.
 * The resolver endpoint is build-time configuration and cannot be changed by
 * a settings payload, which keeps the manifest's host permission narrow.
 */
export function validateSettings(
  input: unknown,
  fallback: AppSettings = DEFAULT_SETTINGS,
): SettingsValidation {
  if (!isRecord(input)) return { ok: false, errors: ["Settings must be an object."] };
  const errors: string[] = [];

  const rawToken = input["accessToken"];
  const accessToken = typeof rawToken === "string" ? rawToken.trim() : fallback.accessToken;
  if (accessToken.length < 16) errors.push("Access token must be at least 16 characters.");
  if (/\s/.test(accessToken)) errors.push("Access token must not contain spaces.");

  const rawName = input["operatorName"];
  const operatorNameRaw = typeof rawName === "string" ? rawName.trim() : fallback.operatorName;
  const operatorName = operatorNameRaw.slice(0, 60);
  if (!operatorName) errors.push("Operator name is required for the audit trail.");
  if (/[\u0000-\u001f\u007f]/.test(operatorName)) errors.push("Operator name contains control characters.");

  const rawBatch = input["batchSize"];
  const batchSize = typeof rawBatch === "number" ? rawBatch : fallback.batchSize;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    errors.push(`Batch size must be a whole number between 1 and ${MAX_BATCH_SIZE}.`);
  }

  const rawRetention = input["retentionDays"];
  const retentionDays = typeof rawRetention === "number" ? rawRetention : fallback.retentionDays;
  if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 365) {
    errors.push("Retention must be a whole number of days between 0 and 365 (0 keeps data until cleared).");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, settings: { accessToken, operatorName, batchSize, retentionDays } };
}

export function hasUsableToken(settings: AppSettings): boolean {
  return settings.accessToken.trim().length >= 16 && !/\s/.test(settings.accessToken);
}

export function maskToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

function storageGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (items) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message ?? "Could not read extension storage."));
        return;
      }
      resolve(items[key] as T | undefined);
    });
  });
}

function storageSet(key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message ?? "Could not write extension storage."));
        return;
      }
      resolve();
    });
  });
}

export async function loadSettings(): Promise<AppSettings> {
  let stored: unknown;
  try {
    stored = await storageGet<unknown>(STORAGE_KEY);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (!isRecord(stored)) return { ...DEFAULT_SETTINGS };
  const validated = validateSettings({ ...DEFAULT_SETTINGS, ...stored }, DEFAULT_SETTINGS);
  return validated.ok ? validated.settings : { ...DEFAULT_SETTINGS };
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadSettings();
  const candidate = { ...current, ...patch };
  const validated = validateSettings(candidate, current);
  if (!validated.ok) throw new Error(validated.errors.join(" "));
  await storageSet(STORAGE_KEY, validated.settings);
  return validated.settings;
}

export async function clearSettings(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    chrome.storage.local.remove(STORAGE_KEY, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message ?? "Could not clear settings."));
        return;
      }
      resolve();
    });
  });
}
