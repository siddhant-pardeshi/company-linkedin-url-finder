import type { JobSnapshot, ExtensionRequest, ExtensionResponse, Job, AppInfo } from "../types.js";
import { APP_VERSION, BUILD_COMMIT, BUILD_ENV, BUILD_TIME, RESOLVER_ENDPOINT } from "../types.js";
import { clearSettings, loadSettings, saveSettings } from "../settings.js";
import { JobEngine } from "../job/engine.js";
import { IdbRepository } from "../storage/idb.js";
import { ResolverClient } from "../api/client.js";

const TICK_ALARM = "cpf-job-tick";
const COOLDOWN_ALARM = "cpf-cooldown";

let enginePromise: Promise<JobEngine> | null = null;

function getEngine(): Promise<JobEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const repository = await IdbRepository.create();
      const client = new ResolverClient({
        getToken: async () => (await loadSettings()).accessToken,
      });
      return new JobEngine({
        repository,
        client,
        getSettings: loadSettings,
        logger: (event, fields) => {
          if (BUILD_ENV === "development") console.debug(`[cpf] ${event}`, fields ?? {});
        },
      });
    })().catch((error: unknown) => {
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

async function clearAlarms(): Promise<void> {
  await chrome.alarms.clear(TICK_ALARM);
  await chrome.alarms.clear(COOLDOWN_ALARM);
}

async function scheduleAlarms(job: Job): Promise<void> {
  await clearAlarms();
  if (job.state === "running") {
    await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  }
  if (job.state === "paused" && job.pauseReason === "rate_limit" && job.cooldownUntil) {
    const when = Math.max(Date.now() + 1000, Date.parse(job.cooldownUntil) + 1000);
    await chrome.alarms.create(COOLDOWN_ALARM, { when });
  }
}

function runInBackground(jobId: string): void {
  void (async () => {
    try {
      const engine = await getEngine();
      await engine.run(jobId);
      const snapshot = await engine.snapshot(jobId);
      if (snapshot) await scheduleAlarms(snapshot.job);
    } catch (error) {
      console.error("Company Page Finder: job run failed", error instanceof Error ? error.name : "unknown");
    }
  })();
}

async function openWorkspace(): Promise<void> {
  const url = chrome.runtime.getURL("workspace.html");
  try {
    const runtime = chrome.runtime as unknown as {
      getContexts?: (filter: {
        contextTypes: string[];
        documentUrls?: string[];
      }) => Promise<Array<{ tabId?: number; windowId?: number }>>;
    };
    const contexts = await runtime.getContexts?.({ contextTypes: ["TAB"], documentUrls: [url] });
    const existing = contexts?.find((context) => typeof context.tabId === "number");
    if (existing?.tabId !== undefined) {
      await chrome.tabs.update(existing.tabId, { active: true });
      if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
      return;
    }
  } catch {
    // Fall back to opening a new tab.
  }
  await chrome.tabs.create({ url });
}

async function handleMessage(message: unknown): Promise<unknown> {
  if (!message || typeof message !== "object" || typeof (message as { type?: unknown }).type !== "string") {
    throw new JobError("invalid_request", "Unsupported extension message.");
  }
  const request = message as ExtensionRequest;
  const engine = await getEngine();

  switch (request.type) {
    case "job:start": {
      const job = await engine.createJob(request.rows, {
        ...(request.batchSize !== undefined ? { batchSize: request.batchSize } : {}),
      });
      await scheduleAlarms(job);
      runInBackground(job.id);
      return job;
    }
    case "job:latest":
      return engine.latestSnapshot();
    case "job:snapshot":
      return engine.snapshot(request.jobId);
    case "job:rows":
      return engine.listRows(request.jobId);
    case "job:audit":
      return engine.listAudit(request.jobId);
    case "job:pause": {
      const job = await engine.pause(request.jobId);
      await scheduleAlarms(job);
      return job;
    }
    case "job:resume": {
      const job = await engine.resume(request.jobId);
      await scheduleAlarms(job);
      runInBackground(job.id);
      return job;
    }
    case "job:cancel": {
      const job = await engine.cancel(request.jobId);
      await clearAlarms();
      return job;
    }
    case "job:retry-failed": {
      const count = await engine.retryFailed(request.jobId);
      const snapshot = await engine.snapshot(request.jobId);
      if (snapshot) await scheduleAlarms(snapshot.job);
      if (count > 0) runInBackground(request.jobId);
      return count;
    }
    case "job:retry-rows": {
      const count = await engine.retryRows(request.jobId, request.rowIds);
      const snapshot = await engine.snapshot(request.jobId);
      if (snapshot) await scheduleAlarms(snapshot.job);
      runInBackground(request.jobId);
      return count;
    }
    case "job:clear": {
      await engine.clearJob(request.jobId);
      await clearAlarms();
      return { cleared: true };
    }
    case "row:update-context": {
      const row = await engine.updateRowContext(request.jobId, request.rowId, request.context);
      runInBackground(request.jobId);
      return row;
    }
    case "row:accept-candidate":
      return engine.acceptCandidate(request.jobId, request.rowId, request.canonicalUrl);
    case "row:reject-candidate":
      return engine.rejectCandidate(request.jobId, request.rowId, request.canonicalUrl);
    case "row:audit":
      return engine.listAudit(request.jobId, request.rowId);
    case "settings:get":
      return loadSettings();
    case "settings:save":
      return saveSettings(request.patch);
    case "settings:test": {
      const client = new ResolverClient({ getToken: async () => (await loadSettings()).accessToken });
      return client.whoami();
    }
    case "data:clear-all": {
      await engine.clearAll();
      await clearSettings();
      await clearAlarms();
      return { cleared: true };
    }
    case "app:info": {
      const info: AppInfo = {
        version: APP_VERSION,
        buildEnv: BUILD_ENV,
        buildCommit: BUILD_COMMIT,
        buildTime: BUILD_TIME,
        endpoint: RESOLVER_ENDPOINT,
      };
      return info;
    }
    default:
      throw new JobError("invalid_request", "Unsupported extension message.");
  }
}

class JobError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "JobError";
    this.code = code;
  }
}

function errorResponse(error: unknown): ExtensionResponse<never> {
  if (error instanceof JobError || (error && typeof error === "object" && "code" in error)) {
    const code = String((error as { code: unknown }).code);
    const message = error instanceof Error ? error.message : "The request failed.";
    return { ok: false, error: { code, message } };
  }
  return {
    ok: false,
    error: {
      code: "internal_error",
      message: error instanceof Error ? error.message : "The request failed unexpectedly.",
    },
  };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  void handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error: unknown) => sendResponse(errorResponse(error)));
  return true;
});

let recoveryPromise: Promise<void> | null = null;

function recover(): Promise<void> {
  if (!recoveryPromise) {
    recoveryPromise = (async () => {
      try {
        const engine = await getEngine();
        await engine.cleanup();
        const snapshot: JobSnapshot | null = await engine.latestSnapshot();
        if (!snapshot) return;
        await scheduleAlarms(snapshot.job);
        if (snapshot.job.state === "running") {
          await engine.run(snapshot.job.id);
        } else if (snapshot.job.state === "paused" && snapshot.job.pauseReason === "rate_limit") {
          await engine.autoResumeIfReady(snapshot.job.id);
        }
        const after = await engine.snapshot(snapshot.job.id);
        if (after) await scheduleAlarms(after.job);
      } catch (error) {
        console.warn("Company Page Finder: recovery failed", error instanceof Error ? error.name : "unknown");
      }
    })();
  }
  return recoveryPromise;
}

void recover();

chrome.runtime.onStartup.addListener(() => {
  void recover();
});

chrome.runtime.onInstalled.addListener((details) => {
  void recover();
  if (details.reason === "install") void openWorkspace();
});

chrome.action.onClicked.addListener(() => {
  void openWorkspace();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TICK_ALARM && alarm.name !== COOLDOWN_ALARM) return;
  void (async () => {
    try {
      const engine = await getEngine();
      const snapshot = await engine.latestSnapshot();
      if (!snapshot) {
        await clearAlarms();
        return;
      }
      if (snapshot.job.state === "running") {
        await engine.run(snapshot.job.id);
      } else if (snapshot.job.state === "paused" && snapshot.job.pauseReason === "rate_limit") {
        await engine.autoResumeIfReady(snapshot.job.id);
      }
      const after = await engine.snapshot(snapshot.job.id);
      if (after) await scheduleAlarms(after.job);
      else await clearAlarms();
    } catch (error) {
      console.warn("Company Page Finder: alarm failed", error instanceof Error ? error.name : "unknown");
    }
  })();
});
