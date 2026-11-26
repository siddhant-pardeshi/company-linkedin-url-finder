import { AI_PROVIDERS, type AiProvider } from "./settings.js";

function contains(origin: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    chrome.permissions.contains({ origins: [origin] }, (granted) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message ?? "Could not check AI host permission."));
      else resolve(granted);
    });
  });
}

function request(origin: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    chrome.permissions.request({ origins: [origin] }, (granted) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message ?? "Could not request AI host permission."));
      else resolve(granted);
    });
  });
}

export function aiProviderOrigin(provider: AiProvider): string {
  return AI_PROVIDERS[provider].origin;
}

export async function hasAiPermission(provider: AiProvider): Promise<boolean> {
  try {
    return await contains(aiProviderOrigin(provider));
  } catch {
    return false;
  }
}

/**
 * Must be called from a user gesture (a button click). Requesting the optional
 * host keeps the default install permission surface narrow.
 */
export async function requestAiPermission(provider: AiProvider): Promise<boolean> {
  return request(aiProviderOrigin(provider));
}
