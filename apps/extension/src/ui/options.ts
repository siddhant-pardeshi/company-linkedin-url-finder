import { maskToken, hasUsableToken } from "../settings.js";
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
};

let settings: AppSettings | null = null;
let info: AppInfo | null = null;

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
    "This removes every batch, result, evidence record, audit entry, and the saved access token from this browser. It cannot be undone.",
    "Delete everything",
  );
  if (!confirmed) return;
  try {
    await sendMessage({ type: "data:clear-all" });
    settings = await sendMessage<AppSettings>({ type: "settings:get" });
    renderSettings();
    setConnectionState("Not configured", "quiet");
    setBanner("success", "All local job data, evidence, audit entries, and the saved token were deleted.");
    toast("Local data deleted.");
  } catch (error) {
    setBanner("danger", errorMessage(error));
  }
});

async function init(): Promise<void> {
  try {
    const [loadedSettings, loadedInfo] = await Promise.all([
      sendMessage<AppSettings>({ type: "settings:get" }),
      sendMessage<AppInfo>({ type: "app:info" }),
    ]);
    settings = loadedSettings;
    info = loadedInfo;
    renderSettings();
    renderInfo();
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
