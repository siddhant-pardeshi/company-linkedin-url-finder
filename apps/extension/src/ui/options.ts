import { maskToken, hasUsableToken } from "../settings.js";
import {
  AI_PROVIDERS,
  hasUsableAiKey,
  maskApiKey,
  type AiProvider,
  type AiSettings,
} from "../ai/settings.js";
import { hasAiPermission, requestAiPermission } from "../ai/permissions.js";
import type { AppInfo, AppSettings } from "../types.js";
import { askConfirm } from "./confirm.js";
import { errorMessage, sendMessage } from "./messages.js";
import { formatDateTime } from "./format.js";
import { toast } from "./toast.js";

type WhoAmI = { ok: boolean; service: string; version: string; provider: string; time: string };

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const elements = {
  banner: byId("settings-banner"),
  endpoint: byId("endpoint-value"),
  connectionState: byId("connection-state"),
  tokenForm: byId<HTMLFormElement>("token-form"),
  tokenInput: byId<HTMLInputElement>("token-input"),
  tokenHint: byId("token-hint"),
  testConnection: byId<HTMLButtonElement>("test-connection"),
  defaultsForm: byId<HTMLFormElement>("defaults-form"),
  operator: byId<HTMLInputElement>("operator-input"),
  batch: byId<HTMLSelectElement>("batch-input"),
  retention: byId<HTMLSelectElement>("retention-input"),
  defaultsStatus: byId("defaults-status"),
  clearData: byId<HTMLButtonElement>("clear-data"),
  aboutVersion: byId("about-version"),
  aboutBuild: byId("about-build"),
  aboutCommit: byId("about-commit"),
  aboutTime: byId("about-time"),
  aboutEndpoint: byId("about-endpoint"),
  aiForm: byId<HTMLFormElement>("ai-form"),
  aiProvider: byId<HTMLSelectElement>("ai-provider"),
  aiModel: byId<HTMLInputElement>("ai-model"),
  aiKey: byId<HTMLInputElement>("ai-key"),
  aiEnabled: byId<HTMLInputElement>("ai-enabled"),
  aiNote: byId("ai-note"),
  aiStatus: byId("ai-status"),
  aiState: byId("ai-state"),
  aiTest: byId<HTMLButtonElement>("ai-test"),
};

let settings: AppSettings | null = null;
let info: AppInfo | null = null;
let ai: AiSettings | null = null;

function setBanner(kind: "info" | "warn" | "danger" | "success", message: string): void {
  elements.banner.className = `banner banner--${kind}`;
  elements.banner.textContent = message;
  elements.banner.hidden = false;
}

function clearBanner(): void {
  elements.banner.hidden = true;
}

function setConnectionState(label: string, kind: "quiet" | "ok" | "warn" | "danger"): void {
  elements.connectionState.textContent = label;
  elements.connectionState.className = `chip chip--${kind}`;
}

function renderSettings(): void {
  if (!settings) return;
  elements.tokenInput.placeholder = hasUsableToken(settings)
    ? `Saved token ${maskToken(settings.accessToken)} — leave blank to keep it`
    : "Paste the token provisioned by the resolver operator";
  elements.tokenHint.textContent = hasUsableToken(settings)
    ? `A token is saved (${maskToken(settings.accessToken)}). Stored locally; never placed in exports or logs.`
    : "Stored locally. Never placed in exports or logs.";
  elements.operator.value = settings.operatorName;
  elements.batch.value = String(settings.batchSize);
  elements.retention.value = String(settings.retentionDays);
}

function renderInfo(): void {
  if (!info) return;
  elements.endpoint.textContent = info.endpoint;
  elements.aboutVersion.textContent = info.version;
  elements.aboutBuild.textContent =
    info.buildEnv === "development" ? "Development build" : "Production build";
  elements.aboutCommit.textContent = info.buildCommit || "—";
  elements.aboutTime.textContent = formatDateTime(info.buildTime);
  elements.aboutEndpoint.textContent = info.endpoint;
}

function renderAi(): void {
  if (!ai) return;
  elements.aiProvider.value = ai.provider;
  if (document.activeElement !== elements.aiModel) elements.aiModel.value = ai.model;
  elements.aiEnabled.checked = ai.enabled;
  elements.aiKey.placeholder = ai.apiKey
    ? `Saved key ${maskApiKey(ai.apiKey)} — leave blank to keep it`
    : "Paste the provider API key";
  elements.aiNote.textContent = AI_PROVIDERS[ai.provider].note;
  elements.aiState.className = "chip chip--quiet";
  elements.aiState.textContent = "Off";
  if (ai.enabled && !hasUsableAiKey(ai)) {
    elements.aiState.className = "chip chip--warn";
    elements.aiState.textContent = "Key missing";
  } else if (ai.enabled) {
    elements.aiState.className = "chip chip--ok";
    elements.aiState.textContent = "On";
  }
  void hasAiPermission(ai.provider).then((granted) => {
    if (!ai?.enabled || !hasUsableAiKey(ai)) return;
    if (!granted) {
      elements.aiState.className = "chip chip--warn";
      elements.aiState.textContent = "Permission needed";
      elements.aiState.title = `Grant ${AI_PROVIDERS[ai.provider].origin} in Settings`;
    }
  });
}

async function saveAi(options: { test: boolean }): Promise<boolean> {
  const provider = elements.aiProvider.value as AiProvider;
  const enabled = elements.aiEnabled.checked;
  const typedKey = elements.aiKey.value.trim();
  if ((enabled || options.test) && typedKey.length > 0 && typedKey.length < 8) {
    elements.aiStatus.textContent = "API key is too short.";
    return false;
  }
  if ((enabled || options.test) && !typedKey && !(ai && hasUsableAiKey(ai))) {
    elements.aiStatus.textContent = "Save an API key first.";
    elements.aiKey.focus();
    return false;
  }

  if (enabled || options.test) {
    // Must happen inside the user gesture; request before other awaits where possible.
    let granted = false;
    try {
      granted = await requestAiPermission(provider);
    } catch (error) {
      elements.aiStatus.textContent = errorMessage(error);
      return false;
    }
    if (!granted) {
      elements.aiStatus.textContent = "AI host permission was not granted.";
      setBanner(
        "warn",
        `The browser did not grant ${AI_PROVIDERS[provider].origin}. AI assist stays unavailable.`,
      );
      return false;
    }
  }

  try {
    const patch = {
      provider,
      model: elements.aiModel.value.trim() || AI_PROVIDERS[provider].defaultModel,
      enabled,
      ...(typedKey ? { apiKey: typedKey } : {}),
    };
    ai = await sendMessage<AiSettings>({ type: "ai:save", patch });
    elements.aiKey.value = "";
    renderAi();
    clearBanner();

    if (options.test) {
      elements.aiStatus.textContent = "Testing…";
      const result = await sendMessage<{ ok: boolean; provider: string; model: string }>({ type: "ai:test" });
      elements.aiStatus.textContent = `Connected · ${result.provider} · ${result.model}`;
      toast("AI provider connection verified.");
    } else {
      elements.aiStatus.textContent = "Saved.";
      toast("AI settings saved.");
    }
    return true;
  } catch (error) {
    elements.aiStatus.textContent = "";
    setBanner("danger", errorMessage(error));
    return false;
  }
}

elements.aiProvider.addEventListener("change", () => {
  const provider = elements.aiProvider.value as AiProvider;
  const defaults = new Set(Object.values(AI_PROVIDERS).map((entry) => entry.defaultModel));
  if (!elements.aiModel.value.trim() || defaults.has(elements.aiModel.value.trim())) {
    elements.aiModel.value = AI_PROVIDERS[provider].defaultModel;
  }
  elements.aiNote.textContent = AI_PROVIDERS[provider].note;
});

elements.aiForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveAi({ test: false });
});

elements.aiTest.addEventListener("click", () => {
  void saveAi({ test: true });
});

async function saveToken(options: { test: boolean }): Promise<boolean> {
  const typed = elements.tokenInput.value.trim();
  if (!typed && !(settings && hasUsableToken(settings))) {
    setConnectionState("Not configured", "warn");
    setBanner("danger", "Enter an access token before saving.");
    elements.tokenInput.focus();
    return false;
  }

  try {
    if (typed) {
      settings = await sendMessage<AppSettings>({ type: "settings:save", patch: { accessToken: typed } });
      elements.tokenInput.value = "";
      renderSettings();
    }
    setConnectionState(options.test ? "Testing…" : "Saved", "quiet");
    clearBanner();

    if (options.test) {
      const who = await sendMessage<WhoAmI>({ type: "settings:test" });
      setConnectionState("Connected", "ok");
      setBanner(
        "success",
        `Connected to ${who.service} v${who.version} · provider: ${who.provider}. Save a batch only after confirming the provider and your retention expectations.`,
      );
      toast("Resolver connection verified.");
    } else {
      setConnectionState("Saved", "ok");
      toast("Settings saved.");
    }
    return true;
  } catch (error) {
    setConnectionState(options.test ? "Failed" : "Not saved", "danger");
    setBanner("danger", errorMessage(error));
    return false;
  }
}

elements.tokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveToken({ test: false });
});

elements.testConnection.addEventListener("click", () => {
  void saveToken({ test: true });
});

elements.defaultsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const patch: Partial<AppSettings> = {
      operatorName: elements.operator.value.trim(),
      batchSize: Number(elements.batch.value),
      retentionDays: Number(elements.retention.value),
    };
    settings = await sendMessage<AppSettings>({ type: "settings:save", patch });
    renderSettings();
    elements.defaultsStatus.textContent = "Saved.";
    toast("Defaults saved.");
    clearBanner();
  } catch (error) {
    elements.defaultsStatus.textContent = "";
    setBanner("danger", errorMessage(error));
  }
});

elements.clearData.addEventListener("click", async () => {
  const confirmed = await askConfirm(
    "Delete all local data?",
    "This removes every batch, result, evidence record, audit entry, the saved resolver token, and the AI API key from this browser. It cannot be undone.",
    "Delete everything",
  );
  if (!confirmed) return;
  try {
    await sendMessage({ type: "data:clear-all" });
    settings = await sendMessage<AppSettings>({ type: "settings:get" });
    ai = await sendMessage<AiSettings>({ type: "ai:get" });
    renderSettings();
    renderAi();
    setConnectionState("Not configured", "quiet");
    elements.aiStatus.textContent = "";
    setBanner(
      "success",
      "All local job data, evidence, audit entries, the saved token, and the AI key were deleted.",
    );
    toast("Local data deleted.");
  } catch (error) {
    setBanner("danger", errorMessage(error));
  }
});

async function init(): Promise<void> {
  try {
    const [loadedSettings, loadedInfo, loadedAi] = await Promise.all([
      sendMessage<AppSettings>({ type: "settings:get" }),
      sendMessage<AppInfo>({ type: "app:info" }),
      sendMessage<AiSettings>({ type: "ai:get" }),
    ]);
    settings = loadedSettings;
    info = loadedInfo;
    ai = loadedAi;
    renderSettings();
    renderInfo();
    renderAi();
    setConnectionState(
      hasUsableToken(settings) ? "Token saved" : "Not configured",
      hasUsableToken(settings) ? "quiet" : "warn",
    );
    if (info.buildEnv === "development") {
      setBanner(
        "info",
        `Development build · resolver endpoint ${info.endpoint}. Do not distribute this build.`,
      );
    }
  } catch (error) {
    setBanner("danger", errorMessage(error));
  }
}

void init();
