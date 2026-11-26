import {
  describeReason,
  QUERY_SHAPE_LABELS,
  STATUS_DESCRIPTIONS,
  STATUS_LABELS,
  type CandidateEvaluation,
  type RowStatus,
} from "@clf/matching";
import { hasUsableToken } from "../settings.js";
import {
  APP_VERSION,
  MAX_BATCH_SIZE,
  type AppInfo,
  type AppSettings,
  type AuditRecord,
  type Job,
  type JobSnapshot,
  type ResultRow,
} from "../types.js";
import { askConfirm } from "./confirm.js";
import {
  exportFilename,
  parseCsvToRows,
  parsePaste,
  parsePeopleCsvToRows,
  parsePeoplePaste,
  PEOPLE_SAMPLE_CSV,
  rowsToCsv,
  rowsToJson,
  SAMPLE_CSV,
  type ImportResult,
} from "./csv.js";
import { formatClock, formatDateTime, pluralize, truncate } from "./format.js";
import { errorMessage, sendMessage } from "./messages.js";
import { toast } from "./toast.js";
import { rowContextLines, rowDisplayName, rowKind, rowSubtitle } from "../job/rows.js";
import type { RowKind } from "../types.js";
import {
  filterRows,
  paginate,
  progressPercent,
  sortRows,
  STATUS_FILTERS,
  type SortDirection,
  type SortKey,
  type StatusFilter,
} from "./view.js";

type Tab = "paste" | "csv";

type State = {
  settings: AppSettings | null;
  info: AppInfo | null;
  snapshot: JobSnapshot | null;
  rows: ResultRow[];
  lastJobId: string | null;
  lastJobUpdatedAt: string | null;
  lastSnapshotKey: string;
  importResult: ImportResult | null;
  activeTab: Tab;
  mode: RowKind;
  filter: StatusFilter;
  query: string;
  sortKey: SortKey;
  sortDir: SortDirection;
  page: number;
  pageSize: number;
  selected: Set<string>;
  reviewRowId: string | null;
  editRowId: string | null;
  busy: boolean;
};

const state: State = {
  settings: null,
  info: null,
  snapshot: null,
  rows: [],
  lastJobId: null,
  lastJobUpdatedAt: null,
  lastSnapshotKey: "",
  importResult: null,
  activeTab: "paste",
  mode: "company",
  filter: "ALL",
  query: "",
  sortKey: "rowIndex",
  sortDir: "asc",
  page: 1,
  pageSize: 50,
  selected: new Set(),
  reviewRowId: null,
  editRowId: null,
  busy: false,
};

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const ui = {
  buildBadge: byId<HTMLSpanElement>("build-badge"),
  tabPaste: byId<HTMLButtonElement>("tab-paste"),
  tabCsv: byId<HTMLButtonElement>("tab-csv"),
  panelPaste: byId<HTMLDivElement>("panel-paste"),
  panelCsv: byId<HTMLDivElement>("panel-csv"),
  paste: byId<HTMLTextAreaElement>("paste-input"),
  csvDrop: byId<HTMLDivElement>("csv-drop"),
  csvInput: byId<HTMLInputElement>("csv-input"),
  csvFileName: byId<HTMLSpanElement>("csv-file-name"),
  csvUploadTitle: byId<HTMLElement>("csv-upload-title"),
  csvHint: byId<HTMLElement>("csv-hint"),
  pasteLabel: byId<HTMLElement>("paste-label"),
  companyColumnLabel: byId<HTMLButtonElement>("company-column-label"),
  modeButtons: [...document.querySelectorAll<HTMLButtonElement>("button[data-mode]")],
  loadExample: byId<HTMLButtonElement>("load-example"),
  downloadSample: byId<HTMLButtonElement>("download-sample"),
  summary: byId<HTMLDivElement>("import-summary"),
  errors: byId<HTMLUListElement>("import-errors"),
  batchSize: byId<HTMLSelectElement>("batch-size"),
  start: byId<HTMLButtonElement>("start-button"),
  tokenHint: byId<HTMLParagraphElement>("token-hint"),
  globalBanner: byId<HTMLDivElement>("global-banner"),
  jobSection: byId<HTMLElement>("job-section"),
  jobMeta: byId<HTMLParagraphElement>("job-meta"),
  jobBanner: byId<HTMLDivElement>("job-banner"),
  aiBanner: byId<HTMLDivElement>("ai-banner"),
  pause: byId<HTMLButtonElement>("pause-button"),
  resume: byId<HTMLButtonElement>("resume-button"),
  cancel: byId<HTMLButtonElement>("cancel-button"),
  newBatch: byId<HTMLButtonElement>("new-batch-button"),
  stats: byId<HTMLDivElement>("stats"),
  progressRoot: byId<HTMLDivElement>("progress-root"),
  progressBar: byId<HTMLDivElement>("progress-bar"),
  progressText: byId<HTMLSpanElement>("progress-text"),
  jobState: byId<HTMLSpanElement>("job-state"),
  resultsSection: byId<HTMLElement>("results-section"),
  resultsMeta: byId<HTMLParagraphElement>("results-meta"),
  search: byId<HTMLInputElement>("search-input"),
  statusFilter: byId<HTMLSelectElement>("status-filter"),
  pageSize: byId<HTMLSelectElement>("page-size"),
  retryFailed: byId<HTMLButtonElement>("retry-failed"),
  retrySelected: byId<HTMLButtonElement>("retry-selected"),
  exportCsv: byId<HTMLButtonElement>("export-csv"),
  exportJson: byId<HTMLButtonElement>("export-json"),
  tableWrap: byId<HTMLDivElement>("table-wrap"),
  tbody: byId<HTMLTableSectionElement>("results-body"),
  selectAll: byId<HTMLInputElement>("select-all"),
  empty: byId<HTMLDivElement>("empty-results"),
  prev: byId<HTMLButtonElement>("prev-page"),
  next: byId<HTMLButtonElement>("next-page"),
  pageLabel: byId<HTMLSpanElement>("page-label"),
  reviewDialog: byId<HTMLDialogElement>("review-dialog"),
  reviewTitle: byId<HTMLHeadingElement>("review-title"),
  reviewSubtitle: byId<HTMLParagraphElement>("review-subtitle"),
  reviewBody: byId<HTMLDivElement>("review-body"),
  reviewClose: byId<HTMLButtonElement>("review-close"),
  editDialog: byId<HTMLDialogElement>("edit-dialog"),
  editForm: byId<HTMLFormElement>("edit-form"),
  editSubtitle: byId<HTMLParagraphElement>("edit-subtitle"),
  editCountry: byId<HTMLInputElement>("edit-country"),
  editRegion: byId<HTMLInputElement>("edit-region"),
  editCity: byId<HTMLInputElement>("edit-city"),
  editDomain: byId<HTMLInputElement>("edit-domain"),
  editWebsite: byId<HTMLInputElement>("edit-website"),
  editAlias: byId<HTMLInputElement>("edit-alias"),
  editNotes: byId<HTMLTextAreaElement>("edit-notes"),
  editCompanyFields: byId<HTMLDivElement>("edit-company-fields"),
  editPersonFields: byId<HTMLDivElement>("edit-person-fields"),
  editPersonCompany: byId<HTMLInputElement>("edit-person-company"),
  editJobTitle: byId<HTMLInputElement>("edit-job-title"),
  editPersonLocation: byId<HTMLInputElement>("edit-person-location"),
  editEmail: byId<HTMLInputElement>("edit-email"),
  editPhone: byId<HTMLInputElement>("edit-phone"),
  editClose: byId<HTMLButtonElement>("edit-close"),
  editCancel: byId<HTMLButtonElement>("edit-cancel"),
};

const JOB_STATE_LABELS: Record<Job["state"], string> = {
  running: "Running",
  paused: "Paused",
  cancelled: "Cancelled",
  completed: "Completed",
};

const PAUSE_LABELS: Record<string, string> = {
  user: "Paused by you",
  auth: "Access token rejected",
  rate_limit: "Provider cooldown",
  network: "Resolver unreachable",
  missing_token: "Access token missing",
  request_error: "Request rejected",
};

function jobActive(): boolean {
  return state.snapshot?.job.state === "running" || state.snapshot?.job.state === "paused";
}

function statusBadge(status: RowStatus): HTMLSpanElement {
  const badge = createElement("span", `badge badge--${status.toLowerCase()}`, STATUS_LABELS[status]);
  badge.title = STATUS_DESCRIPTIONS[status];
  return badge;
}

function showBanner(
  container: HTMLElement,
  options: {
    kind: "info" | "warn" | "danger" | "success";
    title: string;
    message: string;
    actions?: Array<{ label: string; href?: string; onClick?: () => void; primary?: boolean }>;
  },
): void {
  container.hidden = false;
  container.className = `banner banner--${options.kind}`;
  container.replaceChildren();
  const body = createElement("div", "banner__body");
  body.append(createElement("strong", "banner__title", options.title));
  body.append(createElement("span", undefined, options.message));
  container.append(body);
  if (options.actions && options.actions.length > 0) {
    const actions = createElement("div", "banner__actions");
    for (const action of options.actions) {
      if (action.href) {
        const link = createElement(
          "a",
          `button button--small ${action.primary ? "button--primary" : "button--ghost"}`,
          action.label,
        );
        link.href = action.href;
        actions.append(link);
      } else if (action.onClick) {
        const button = createElement(
          "button",
          `button button--small ${action.primary ? "button--primary" : "button--ghost"}`,
          action.label,
        );
        button.type = "button";
        button.addEventListener("click", () => action.onClick?.());
        actions.append(button);
      } else {
        actions.append(createElement("span", "chip", action.label));
      }
    }
    body.append(actions);
  }
}

function hideBanner(container: HTMLElement): void {
  container.hidden = true;
  container.replaceChildren();
}

function setBusy(busy: boolean): void {
  state.busy = busy;
  ui.start.textContent = busy ? "Starting…" : "Start batch";
  renderIntake();
}

function populateSelects(): void {
  ui.batchSize.replaceChildren();
  for (let size = 1; size <= MAX_BATCH_SIZE; size += 1) {
    const option = createElement("option", undefined, String(size));
    option.value = String(size);
    ui.batchSize.append(option);
  }
  ui.statusFilter.replaceChildren();
  for (const filter of STATUS_FILTERS) {
    const option = createElement("option", undefined, filter.label);
    option.value = filter.value;
    ui.statusFilter.append(option);
  }
}

function renderBuildBadge(): void {
  if (!state.info) {
    ui.buildBadge.hidden = true;
    return;
  }
  ui.buildBadge.hidden = false;
  ui.buildBadge.textContent = state.info.buildEnv === "development" ? "Dev build" : `v${state.info.version}`;
  ui.buildBadge.title = `Build ${state.info.buildCommit || "unknown"} · ${formatDateTime(state.info.buildTime)}`;
}

function renderMode(): void {
  const person = state.mode === "person";
  for (const button of ui.modeButtons) {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  ui.pasteLabel.textContent = person ? "Full names, one per line" : "Company names, one per line";
  ui.paste.placeholder = person
    ? "Ada Lovelace\nGrace Hopper\nAlan Turing"
    : "Microsoft\nExample Private Ltd\nAcme";
  ui.csvUploadTitle.textContent = person ? "Drop a people CSV here" : "Drop a company CSV here";
  ui.csvHint.textContent = person
    ? "UTF-8. Required: full_name. Optional: company, job_title, location, email, phone, notes. Email and phone stay local and are never sent to the search provider."
    : "UTF-8. Required: company_name. Optional: country, region, city, official_domain, official_website, alias, notes.";
  ui.companyColumnLabel.textContent = person ? "Person" : "Company";
}

function renderIntake(): void {
  if (!state.settings) return;
  renderMode();
  if (document.activeElement !== ui.batchSize) ui.batchSize.value = String(state.settings.batchSize);
  if (document.activeElement !== ui.statusFilter) ui.statusFilter.value = state.filter;
  if (document.activeElement !== ui.pageSize) ui.pageSize.value = String(state.pageSize);

  const result = state.importResult;
  const tokenReady = hasUsableToken(state.settings);
  ui.tokenHint.hidden = tokenReady;

  if (!result) {
    ui.summary.hidden = true;
    ui.errors.hidden = true;
  } else {
    ui.summary.hidden = false;
    ui.summary.replaceChildren();
    const addChip = (text: string, className = "chip"): void => {
      ui.summary.append(createElement("span", className, text));
    };
    addChip(pluralize(result.rows.length, "valid row"));
    if (result.duplicateRows > 0)
      addChip(`${pluralize(result.duplicateRows, "duplicate")} will share a lookup`);
    if (result.errors.length > 0) {
      addChip(pluralize(result.errors.length, "issue"), "chip chip--danger");
    }
    if (
      state.mode === "person" &&
      result.rows.length > 0 &&
      !result.rows.some((row) =>
        row.kind === "person" ? Boolean(row.company || row.jobTitle || row.location) : false,
      )
    ) {
      addChip("Add company, title, or location for auto-match", "chip chip--warn");
    }
    if (jobActive()) addChip("Batch active", "chip chip--warn");

    ui.errors.hidden = result.errors.length === 0;
    ui.errors.replaceChildren();
    for (const error of result.errors.slice(0, 8)) {
      const item = createElement("li", undefined, error.message);
      item.dataset.line = String(error.line);
      ui.errors.append(item);
    }
    if (result.errors.length > 8) {
      ui.errors.append(createElement("li", "no-line", `…and ${result.errors.length - 8} more.`));
    }
  }

  let disabledReason = "";
  if (!tokenReady) disabledReason = "Add a resolver access token in Settings first.";
  else if (jobActive()) disabledReason = "A batch is already active. Pause or cancel it first.";
  else if (!result || result.rows.length === 0) disabledReason = "Add at least one valid row.";
  else if (result.errors.length > 0) disabledReason = "Fix the import issues before starting.";
  else if (state.busy) disabledReason = "Starting the batch…";

  ui.start.disabled = Boolean(disabledReason);
  ui.start.title = disabledReason;
}

function renderGlobalBanner(): void {
  if (state.info?.buildEnv === "development") {
    showBanner(ui.globalBanner, {
      kind: "info",
      title: "Development build",
      message: `Resolver endpoint: ${state.info.endpoint}. Use the mock provider for demos; never distribute this build.`,
    });
  } else {
    hideBanner(ui.globalBanner);
  }
}

function renderJob(): void {
  const snapshot = state.snapshot;
  if (!snapshot) {
    ui.jobSection.hidden = true;
    ui.resultsSection.hidden = true;
    return;
  }

  const job = snapshot.job;
  const stats = snapshot.stats;
  ui.jobSection.hidden = false;
  ui.resultsSection.hidden = false;
  ui.jobMeta.textContent = [
    `#${job.id.slice(0, 8)}`,
    job.mode === "person" ? "People" : "Companies",
    job.operatorName,
    pluralize(job.totalRows, "row"),
    `${pluralize(job.totalLookups, "lookup")} after de-duplication`,
    `${job.batchSize} per request`,
  ].join(" · ");

  if (job.aiNote) {
    showBanner(ui.aiBanner, {
      kind: "warn",
      title: "AI assist unavailable for this batch",
      message: `${job.aiNote} The deterministic LinkedIn profile search continued.`,
    });
  } else {
    hideBanner(ui.aiBanner);
  }

  ui.jobState.textContent = JOB_STATE_LABELS[job.state];
  ui.jobState.className = `chip ${
    job.state === "running"
      ? "chip--ok"
      : job.state === "completed"
        ? "chip--ok"
        : job.state === "paused"
          ? "chip--warn"
          : ""
  }`;

  ui.pause.hidden = job.state !== "running";
  ui.resume.hidden = job.state !== "paused";
  ui.cancel.hidden = job.state === "completed" || job.state === "cancelled";
  ui.newBatch.hidden = job.state === "running" || job.state === "paused";

  const matched = stats.MATCHED + stats.USER_CONFIRMED;
  const pending = stats.PENDING + stats.IN_PROGRESS;
  const cards: Array<{ label: string; value: number; className: string; title: string }> = [
    { label: "Rows", value: stats.total, className: "", title: "Original input rows" },
    {
      label: "Matched",
      value: matched,
      className: "stat--matched",
      title: "High-confidence matches plus user-confirmed rows",
    },
    {
      label: "Review",
      value: stats.REVIEW_REQUIRED,
      className: "stat--review",
      title: "Valid candidates that need a human decision",
    },
    {
      label: "Not found",
      value: stats.NOT_FOUND,
      className: "",
      title: "No valid company page in the provider results",
    },
    {
      label: "Errors",
      value: stats.ERROR,
      className: "stat--error",
      title: "Lookup or validation failures; retry may help",
    },
    { label: "Pending", value: pending, className: "", title: "Waiting or currently searching" },
  ];
  ui.stats.replaceChildren();
  for (const card of cards) {
    const element = createElement("div", `stat ${card.className}`.trim());
    element.title = card.title;
    element.append(createElement("span", "stat__label", card.label));
    element.append(createElement("span", "stat__value", card.value.toLocaleString()));
    ui.stats.append(element);
  }

  const percent = progressPercent(stats);
  ui.progressBar.style.width = `${percent}%`;
  ui.progressRoot.setAttribute("aria-valuenow", String(percent));
  const processed = stats.total - pending;
  ui.progressText.textContent = `${processed.toLocaleString()} of ${stats.total.toLocaleString()} rows checked · ${percent}%`;
  ui.jobState.title = `Updated ${formatClock(job.updatedAt)}`;

  renderJobBanner(job, stats);
}

function renderJobBanner(job: Job, stats: JobSnapshot["stats"]): void {
  if (job.state === "running") {
    hideBanner(ui.jobBanner);
    return;
  }
  if (job.state === "completed") {
    showBanner(ui.jobBanner, {
      kind: "success",
      title: "Batch complete",
      message: `${pluralize(stats.MATCHED + stats.USER_CONFIRMED, "row")} matched or confirmed, ${pluralize(
        stats.REVIEW_REQUIRED,
        "row",
      )} need review, ${pluralize(stats.NOT_FOUND, "row")} not found, ${pluralize(stats.ERROR, "row")} errored.`,
    });
    return;
  }
  if (job.state === "cancelled") {
    showBanner(ui.jobBanner, {
      kind: "info",
      title: "Batch cancelled",
      message:
        "Processed rows and evidence are preserved and can still be exported. Start a new batch to continue with other names.",
    });
    return;
  }

  const reason = job.pauseReason ?? "user";
  const title = PAUSE_LABELS[reason] ?? "Paused";
  const message = job.lastError?.message ?? "Resume when you are ready; the queue is checkpointed.";
  const actions: Array<{ label: string; href?: string; onClick?: () => void; primary?: boolean }> = [];

  if (reason === "auth" || reason === "missing_token") {
    actions.push({ label: "Open settings", href: "options.html", primary: true });
    actions.push({ label: "Resume", onClick: () => void resumeJob() });
  } else if (reason === "rate_limit") {
    if (job.cooldownUntil) {
      actions.push({
        label: `Cooldown until ${formatClock(job.cooldownUntil)}`,
      });
    }
    actions.push({ label: "Resume now", onClick: () => void resumeJob(), primary: true });
  } else {
    actions.push({ label: "Resume", onClick: () => void resumeJob(), primary: true });
    if (stats.ERROR > 0) actions.push({ label: "Retry failed rows", onClick: () => void retryFailed() });
  }

  showBanner(ui.jobBanner, {
    kind: reason === "auth" || reason === "missing_token" || reason === "request_error" ? "danger" : "warn",
    title,
    message,
    actions,
  });
}

function renderResults(): void {
  const snapshot = state.snapshot;
  if (!snapshot) return;

  const rows = state.rows;
  const filtered = filterRows(rows, state.filter, state.query);
  const sorted = sortRows(filtered, state.sortKey, state.sortDir);
  const page = paginate(sorted, state.page, state.pageSize);
  state.page = page.page;
  const jobMode = snapshot.job.mode ?? (rows[0] ? rowKind(rows[0].raw) : "company");
  ui.companyColumnLabel.textContent = jobMode === "person" ? "Person" : "Company";
  ui.search.placeholder =
    jobMode === "person" ? "Search person, company, title, or URL" : "Search company, country, or URL";

  const matched = rows.filter((row) => row.status === "MATCHED").length;
  const confirmed = rows.filter((row) => row.status === "USER_CONFIRMED").length;
  const review = rows.filter((row) => row.status === "REVIEW_REQUIRED").length;
  const errors = rows.filter((row) => row.status === "ERROR").length;
  ui.resultsMeta.textContent = `${pluralize(rows.length, "row")} · ${pluralize(
    matched + confirmed,
    "matched row",
  )} · ${pluralize(review, "row")} in review · ${pluralize(errors, "error")}`;

  if (document.activeElement !== ui.search) ui.search.value = state.query;
  ui.statusFilter.value = state.filter;
  ui.pageSize.value = String(state.pageSize);

  ui.tbody.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const row of page.items) fragment.append(renderRow(row));
  ui.tbody.append(fragment);

  ui.empty.hidden = page.items.length > 0;
  ui.empty.textContent = rows.length === 0 ? "No rows yet." : "No rows match this filter.";

  for (const sorter of document.querySelectorAll<HTMLButtonElement>("button[data-sort]")) {
    const key = sorter.dataset.sort as SortKey | undefined;
    sorter.dataset.active = state.sortKey === key ? state.sortDir : "";
    const header = sorter.closest("th");
    if (header)
      header.setAttribute(
        "aria-sort",
        state.sortKey === key ? (state.sortDir === "asc" ? "ascending" : "descending") : "none",
      );
  }

  ui.pageLabel.textContent =
    page.items.length === 0
      ? `0 of ${filtered.length}`
      : `${page.start}–${page.end} of ${filtered.length} · page ${page.page} of ${page.totalPages}`;
  ui.prev.disabled = page.page <= 1;
  ui.next.disabled = page.page >= page.totalPages;

  const pageIds = page.items.map((row) => row.id);
  const selectedOnPage = pageIds.filter((id) => state.selected.has(id)).length;
  ui.selectAll.checked = pageIds.length > 0 && selectedOnPage === pageIds.length;
  ui.selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < pageIds.length;
  ui.selectAll.disabled = pageIds.length === 0;

  ui.retrySelected.disabled = state.selected.size === 0 || snapshot.job.state === "cancelled";
  ui.retrySelected.textContent =
    state.selected.size > 0 ? `Retry selected (${state.selected.size})` : "Retry selected";
  ui.retryFailed.disabled = errors === 0 || snapshot.job.state === "cancelled";
  ui.exportCsv.disabled = rows.length === 0;
  ui.exportJson.disabled = rows.length === 0;
}

function renderRow(row: ResultRow): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.dataset.rowId = row.id;
  if (row.status === "REVIEW_REQUIRED") tr.classList.add("is-review");
  if (row.status === "ERROR") tr.classList.add("is-error");

  const checkCell = createElement("td", "cell-check");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = state.selected.has(row.id);
  const displayName = rowDisplayName(row.raw);
  const subtitle = rowSubtitle(row.raw);
  checkbox.setAttribute("aria-label", `Select row ${row.rowIndex}: ${displayName}`);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.selected.add(row.id);
    else state.selected.delete(row.id);
    renderResults();
  });
  checkCell.append(checkbox);
  tr.append(checkCell);

  const number = createElement("td", "cell-num", String(row.rowIndex));
  tr.append(number);

  const companyCell = createElement("td", "company-cell");
  companyCell.append(createElement("strong", undefined, displayName));
  if (subtitle) companyCell.append(createElement("small", undefined, subtitle));
  tr.append(companyCell);

  const contextCell = createElement("td", "context-cell");
  contextCell.dataset.label = "Context";
  const contextLines = rowContextLines(row.raw);
  if (contextLines.length === 0) contextCell.classList.add("context-cell--empty");
  contextCell.append(createElement("span", undefined, contextLines[0] ?? "—"));
  if (contextLines[1]) contextCell.append(createElement("span", undefined, contextLines[1]));
  tr.append(contextCell);

  const statusCell = createElement("td");
  statusCell.append(statusBadge(row.status));
  tr.append(statusCell);

  const urlCell = createElement("td", "url-cell");
  urlCell.dataset.label = "Selected URL";
  if (
    row.selectedUrl &&
    (row.selectedUrl.startsWith("https://www.linkedin.com/company/") ||
      row.selectedUrl.startsWith("https://www.linkedin.com/in/"))
  ) {
    const link = createElement("a", undefined, row.selectedUrl.replace("https://www.linkedin.com", ""));
    link.href = row.selectedUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = row.selectedUrl;
    urlCell.append(link);
  } else {
    urlCell.append(createElement("span", "muted", "—"));
  }
  tr.append(urlCell);

  const evidenceCell = createElement("td", "evidence-cell");
  evidenceCell.dataset.label = "Evidence";
  if (row.error) {
    evidenceCell.append(
      createElement("span", "evidence-strong evidence-error", describeReason(row.error.code)),
    );
    evidenceCell.append(createElement("span", "evidence-summary", truncate(row.error.message, 110)));
  } else if (row.evaluation) {
    evidenceCell.append(
      createElement(
        "span",
        "evidence-strong",
        describeReason(row.evaluation.reasonCodes[0] ?? row.evaluation.status),
      ),
    );
    evidenceCell.append(
      createElement("span", "evidence-summary", truncate(row.evaluation.reasons[0] ?? "", 110)),
    );
    evidenceCell.append(
      createElement("span", "muted", ` · ${pluralize(row.evaluation.candidates.length, "candidate")}`),
    );
  } else {
    evidenceCell.append(createElement("span", "muted", "No evidence yet."));
  }
  tr.append(evidenceCell);

  const checkedCell = createElement("td", "check-cell", formatDateTime(row.checkedAt));
  checkedCell.dataset.label = "Checked";
  tr.append(checkedCell);

  const actionsCell = createElement("td", "actions-cell");
  const review = createElement("button", "tiny-button", "Review");
  review.type = "button";
  review.dataset.action = "review";
  review.dataset.rowId = row.id;
  review.disabled = row.status === "IN_PROGRESS";
  actionsCell.append(review);

  const edit = createElement("button", "tiny-button", "Edit");
  edit.type = "button";
  edit.dataset.action = "edit";
  edit.dataset.rowId = row.id;
  edit.disabled = row.status === "IN_PROGRESS" || state.snapshot?.job.state === "cancelled";
  actionsCell.append(edit);
  tr.append(actionsCell);

  return tr;
}

function render(): void {
  renderMode();
  renderBuildBadge();
  renderIntake();
  renderJob();
  renderResults();
  renderGlobalBanner();
}

function setImportResult(result: ImportResult | null): void {
  state.importResult = result;
  state.page = 1;
  state.selected.clear();
  renderIntake();
  if (state.snapshot) renderResults();
}

function updatePasteImport(): void {
  setImportResult(state.mode === "person" ? parsePeoplePaste(ui.paste.value) : parsePaste(ui.paste.value));
}

function updateCsvImport(text: string): void {
  setImportResult(state.mode === "person" ? parsePeopleCsvToRows(text) : parseCsvToRows(text));
}

function reparseActiveTab(): void {
  if (state.activeTab === "paste") {
    updatePasteImport();
    return;
  }
  if (ui.csvFileName.dataset["hasFile"] === "true") updateCsvImport(ui.csvFileName.dataset["text"] ?? "");
  else setImportResult(null);
}

function setMode(mode: RowKind): void {
  if (state.mode === mode) return;
  state.mode = mode;
  state.importResult = null;
  state.selected.clear();
  state.page = 1;
  renderMode();
  reparseActiveTab();
  renderIntake();
  if (state.snapshot) renderResults();
}

function selectTab(tab: Tab): void {
  state.activeTab = tab;
  ui.tabPaste.setAttribute("aria-selected", String(tab === "paste"));
  ui.tabCsv.setAttribute("aria-selected", String(tab === "csv"));
  ui.tabPaste.tabIndex = tab === "paste" ? 0 : -1;
  ui.tabCsv.tabIndex = tab === "csv" ? 0 : -1;
  ui.panelPaste.hidden = tab !== "paste";
  ui.panelCsv.hidden = tab !== "csv";
  reparseActiveTab();
}

async function handleCsvFile(file: File): Promise<void> {
  if (file.size > 5 * 1024 * 1024) {
    toast("CSV is too large. Use a file under 5 MB.", "error");
    return;
  }
  try {
    const text = await file.text();
    ui.csvFileName.dataset["hasFile"] = "true";
    ui.csvFileName.dataset["text"] = text;
    ui.csvFileName.textContent = `${file.name} · ${pluralize(text.split(/\r\n|\r|\n/).length - 1, "line")}`;
    selectTab("csv");
    toast(`Imported ${file.name}.`);
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function startBatch(): Promise<void> {
  if (!state.settings || !state.importResult) return;
  if (!hasUsableToken(state.settings)) {
    toast("Add a resolver access token in Settings first.", "error");
    return;
  }
  if (state.importResult.errors.length > 0 || state.importResult.rows.length === 0) return;
  setBusy(true);
  try {
    const job = await sendMessage<Job>({
      type: "job:start",
      rows: state.importResult.rows,
      batchSize: Number(ui.batchSize.value),
    });
    state.lastJobId = null;
    state.lastJobUpdatedAt = null;
    state.selected.clear();
    await refresh(true);
    toast(`Queued ${pluralize(job.totalRows, "row")} across ${pluralize(job.totalLookups, "lookup")}.`);
    ui.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    toast(errorMessage(error), "error");
  } finally {
    setBusy(false);
  }
}

async function resumeJob(): Promise<void> {
  if (!state.snapshot) return;
  try {
    await sendMessage<Job>({ type: "job:resume", jobId: state.snapshot.job.id });
    await refresh(true);
    toast("Batch resumed.");
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function retryFailed(): Promise<void> {
  if (!state.snapshot) return;
  try {
    const count = await sendMessage<number>({ type: "job:retry-failed", jobId: state.snapshot.job.id });
    await refresh(true);
    toast(count > 0 ? `Re-queued ${pluralize(count, "failed row")}.` : "No failed rows to retry.");
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function retrySelected(): Promise<void> {
  if (!state.snapshot || state.selected.size === 0) return;
  try {
    const count = await sendMessage<number>({
      type: "job:retry-rows",
      jobId: state.snapshot.job.id,
      rowIds: [...state.selected],
    });
    state.selected.clear();
    await refresh(true);
    toast(`Re-queued ${pluralize(count, "row")}.`);
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function openReview(rowId: string): Promise<void> {
  const row = state.rows.find((entry) => entry.id === rowId);
  if (!row || !state.snapshot) return;
  state.reviewRowId = rowId;
  const audit = await sendMessage<AuditRecord[]>({
    type: "row:audit",
    jobId: state.snapshot.job.id,
    rowId,
  }).catch(() => []);
  renderReview(row, audit);
  if (!ui.reviewDialog.open) ui.reviewDialog.showModal();
}

function renderReview(row: ResultRow, audit: readonly AuditRecord[]): void {
  ui.reviewTitle.textContent = rowDisplayName(row.raw);
  ui.reviewSubtitle.textContent = `Row #${row.rowIndex} · ${STATUS_LABELS[row.status]} · ${
    row.provider ? `provider ${row.provider}` : "no provider"
  }${row.checkedAt ? ` · checked ${formatDateTime(row.checkedAt)}` : ""}`;

  ui.reviewBody.replaceChildren();

  const summary = createElement("div", "review-summary");
  const list = document.createElement("ul");
  const reasons = row.error ? [row.error.message] : (row.evaluation?.reasons ?? []);
  if (reasons.length === 0) reasons.push("No deterministic evidence is stored for this row yet.");
  for (const reason of reasons) list.append(createElement("li", undefined, reason));
  summary.append(list);
  ui.reviewBody.append(summary);

  const candidates = row.evaluation?.candidates ?? [];
  const section = createElement("section", "drawer-section");
  const heading = createElement("h3");
  heading.append(createElement("span", undefined, "Candidates"));
  heading.append(createElement("span", "chip", String(candidates.length)));
  section.append(heading);

  if (candidates.length === 0) {
    section.append(
      createElement(
        "div",
        "drawer-empty",
        row.evaluation
          ? "The provider returned no valid LinkedIn /company/ URL. See the rejected results below."
          : "No provider evidence is stored for this row.",
      ),
    );
  }

  for (const candidate of candidates) {
    section.append(renderCandidate(row, candidate));
  }
  ui.reviewBody.append(section);

  const excluded = row.evaluation?.excludedResults ?? [];
  if (excluded.length > 0) {
    const excludedSection = createElement("section", "drawer-section");
    excludedSection.append(createElement("h3", undefined, "Rejected results"));
    const excludedList = createElement("ul", "excluded-list");
    for (const entry of excluded.slice(0, 25)) {
      const item = document.createElement("li");
      item.append(createElement("code", undefined, entry.originalUrl));
      item.append(
        createElement(
          "span",
          undefined,
          `${describeReason(entry.reason)}${entry.title ? ` · ${entry.title}` : ""}`,
        ),
      );
      excludedList.append(item);
    }
    excludedSection.append(excludedList);
    ui.reviewBody.append(excludedSection);
  }

  const auditSection = createElement("section", "drawer-section");
  auditSection.append(createElement("h3", undefined, "Audit trail"));
  if (audit.length === 0) {
    auditSection.append(createElement("p", "muted", "No audit entries for this row yet."));
  } else {
    const auditList = createElement("ul", "audit-list");
    for (const entry of audit) {
      const item = document.createElement("li");
      item.append(createElement("span", "audit-action", entry.action.replace(/_/g, " ")));
      item.append(createElement("span", "audit-time", formatDateTime(entry.at)));
      item.append(createElement("span", "audit-detail", `${entry.detail} — ${entry.actor}`));
      auditList.append(item);
    }
    auditSection.append(auditList);
  }
  ui.reviewBody.append(auditSection);
}

function renderCandidate(row: ResultRow, candidate: CandidateEvaluation): HTMLElement {
  const card = createElement("article", `candidate candidate--${candidate.verdict}`);
  const head = createElement("div", "candidate__head");
  const left = createElement("div");
  left.append(createElement("div", "candidate__title", candidate.title || "(no provider title)"));
  const link = createElement("a", "candidate__url", candidate.canonicalUrl);
  link.href = candidate.canonicalUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  left.append(link);
  head.append(left);

  const verdict = createElement(
    "span",
    `badge ${
      candidate.verdict === "selectable"
        ? "badge--matched"
        : candidate.verdict === "review"
          ? "badge--review_required"
          : "badge--not_found"
    }`,
    candidate.verdict === "selectable"
      ? "Eligible"
      : candidate.verdict === "review"
        ? "Needs review"
        : "Excluded",
  );
  head.append(verdict);
  card.append(head);

  if (candidate.discoveredUrl && candidate.discoveredUrl !== candidate.canonicalUrl) {
    card.append(createElement("p", "hint mono", `Provider URL: ${candidate.discoveredUrl}`));
  }

  for (const snippet of candidate.snippets.slice(0, 2)) {
    card.append(createElement("blockquote", "candidate__snippet", snippet));
  }

  const signals = createElement("div", "signals");
  const addSignal = (label: string, className = "chip chip--on"): void => {
    signals.append(createElement("span", className, label));
  };
  const person = row.evaluation?.kind === "person" || rowKind(row.raw) === "person";
  addSignal(
    candidate.signals.titleMatch
      ? person
        ? "Exact name match"
        : "Exact title match"
      : person
        ? "Name mismatch"
        : "Title mismatch",
    candidate.signals.titleMatch ? "chip chip--on" : "chip chip--warn",
  );
  if (person) {
    if (candidate.signals.companyMentioned) addSignal("Company mentioned");
    if (candidate.signals.jobTitleMentioned) addSignal("Job title mentioned");
    if (candidate.signals.locationMentioned) addSignal("Location mentioned");
  } else {
    if (candidate.signals.matchedAlias) addSignal("Alias match");
    if (candidate.signals.domainMentioned) addSignal("Domain mentioned");
    if (candidate.signals.countryMentioned) addSignal("Country mentioned");
  }
  if (candidate.signals.corroboratedBySecondQuery) addSignal("Second query");
  signals.append(createElement("span", "chip", `Slug overlap ${candidate.signals.slugNameScore.toFixed(2)}`));
  if (candidate.signals.titleMatch) {
    const hasContextSignal = person
      ? Boolean(
          candidate.signals.companyMentioned ||
          candidate.signals.jobTitleMentioned ||
          candidate.signals.locationMentioned,
        )
      : Boolean(candidate.signals.domainMentioned || candidate.signals.countryMentioned);
    if (!hasContextSignal && !candidate.signals.corroboratedBySecondQuery) {
      addSignal("Weak corroboration", "chip chip--warn");
    }
  }
  card.append(signals);

  if (candidate.notes.length > 0) {
    const notes = createElement("ul", "notes");
    for (const note of candidate.notes) notes.append(createElement("li", undefined, note));
    card.append(notes);
  }

  if (candidate.queries.length > 0) {
    const details = document.createElement("details");
    details.className = "queries";
    const summary = document.createElement("summary");
    summary.textContent = `Provider queries (${candidate.queries.length})`;
    details.append(summary);
    const list = document.createElement("ul");
    for (const query of candidate.queries) {
      const item = document.createElement("li");
      item.append(createElement("span", "shape", QUERY_SHAPE_LABELS[query.shape] ?? query.shape));
      item.append(createElement("span", undefined, query.query));
      list.append(item);
    }
    details.append(list);
    card.append(details);
  }

  if (candidate.disqualifiers.length > 0) {
    card.append(
      createElement(
        "p",
        "rejected-note",
        `Disqualifiers: ${candidate.disqualifiers.map((code) => describeReason(code)).join(", ")}`,
      ),
    );
  }

  const foot = createElement("div", "candidate__foot");
  const meta = createElement(
    "span",
    "hint",
    candidate.retrievedAt ? `Retrieved ${formatDateTime(candidate.retrievedAt)}` : "",
  );
  foot.append(meta);

  const actions = createElement("div", "candidate__actions");
  const rejectedByUser = row.rejectedCandidates.includes(candidate.canonicalUrl);
  if (rejectedByUser) actions.append(createElement("span", "rejected-note", "Rejected by you"));
  if (row.selectedUrl === candidate.canonicalUrl) {
    actions.append(
      createElement("span", "chip chip--ok", row.status === "USER_CONFIRMED" ? "User confirmed" : "Selected"),
    );
  } else {
    const accept = createElement(
      "button",
      "button button--small button--primary",
      candidate.verdict === "excluded" ? "Accept anyway" : "Accept URL",
    );
    accept.type = "button";
    accept.dataset.reviewAction = "accept";
    accept.dataset.url = candidate.canonicalUrl;
    accept.disabled = row.status === "IN_PROGRESS";
    actions.append(accept);
  }
  if (!rejectedByUser) {
    const reject = createElement("button", "button button--small button--ghost", "Reject");
    reject.type = "button";
    reject.dataset.reviewAction = "reject";
    reject.dataset.url = candidate.canonicalUrl;
    reject.disabled = row.status === "IN_PROGRESS";
    actions.append(reject);
  }
  foot.append(actions);
  card.append(foot);
  return card;
}

async function handleReviewAction(action: string, canonicalUrl: string): Promise<void> {
  if (!state.snapshot || !state.reviewRowId) return;
  const row = state.rows.find((entry) => entry.id === state.reviewRowId);
  if (!row) return;
  const candidate = row.evaluation?.candidates.find((entry) => entry.canonicalUrl === canonicalUrl);

  if (action === "accept" && candidate?.verdict === "excluded") {
    const confirmed = await askConfirm(
      "Accept an excluded candidate?",
      "This candidate did not pass the exact-name rule. Accepting it records a human override as USER_CONFIRMED and is visible in the export and audit trail.",
      "Accept anyway",
    );
    if (!confirmed) return;
  }

  ui.reviewBody.setAttribute("aria-busy", "true");
  try {
    if (action === "accept") {
      await sendMessage<ResultRow>({
        type: "row:accept-candidate",
        jobId: state.snapshot.job.id,
        rowId: row.id,
        canonicalUrl,
      });
      toast("Candidate accepted. The row is now user-confirmed.");
    } else {
      await sendMessage<ResultRow>({
        type: "row:reject-candidate",
        jobId: state.snapshot.job.id,
        rowId: row.id,
        canonicalUrl,
      });
      toast("Candidate rejected.");
    }
    await refresh(true);
    const updated = state.rows.find((entry) => entry.id === row.id);
    if (updated) {
      const audit = await sendMessage<AuditRecord[]>({
        type: "row:audit",
        jobId: state.snapshot.job.id,
        rowId: row.id,
      }).catch(() => []);
      renderReview(updated, audit);
    }
  } catch (error) {
    toast(errorMessage(error), "error");
  } finally {
    ui.reviewBody.removeAttribute("aria-busy");
  }
}

function openEdit(rowId: string): void {
  const row = state.rows.find((entry) => entry.id === rowId);
  if (!row || !state.snapshot) return;
  if (state.snapshot.job.state === "cancelled") {
    toast("This batch was cancelled. Start a new batch instead.", "error");
    return;
  }
  state.editRowId = rowId;
  ui.editSubtitle.textContent = `Row #${row.rowIndex} · original name “${rowDisplayName(row.raw)}” · ${STATUS_LABELS[row.status]}`;
  const person = rowKind(row.raw) === "person";
  ui.editCompanyFields.hidden = person;
  ui.editPersonFields.hidden = !person;
  if (row.raw.kind === "person") {
    ui.editPersonCompany.value = row.raw.company ?? "";
    ui.editJobTitle.value = row.raw.jobTitle ?? "";
    ui.editPersonLocation.value = row.raw.location ?? "";
    ui.editEmail.value = row.raw.email ?? "";
    ui.editPhone.value = row.raw.phone ?? "";
  } else {
    ui.editPersonCompany.value = "";
    ui.editJobTitle.value = "";
    ui.editPersonLocation.value = "";
    ui.editEmail.value = "";
    ui.editPhone.value = "";
  }
  ui.editCountry.value = row.raw.kind === "person" ? "" : (row.raw.country ?? "");
  ui.editRegion.value = row.raw.kind === "person" ? "" : (row.raw.region ?? "");
  ui.editCity.value = row.raw.kind === "person" ? "" : (row.raw.city ?? "");
  ui.editDomain.value = row.raw.kind === "person" ? "" : (row.raw.officialDomain ?? "");
  ui.editWebsite.value = row.raw.kind === "person" ? "" : (row.raw.officialWebsite ?? "");
  ui.editAlias.value = row.raw.kind === "person" ? "" : (row.raw.alias ?? "");
  ui.editNotes.value = row.raw.notes ?? "";
  if (!ui.editDialog.open) ui.editDialog.showModal();
  if (person) ui.editPersonCompany.focus();
  else ui.editDomain.focus();
}

async function exportCsv(): Promise<void> {
  if (!state.snapshot || state.rows.length === 0) {
    toast("There are no rows to export yet.", "error");
    return;
  }
  try {
    const text = `\uFEFF${rowsToCsv(state.rows)}`;
    await downloadText(
      exportFilename("company-page-finder", state.snapshot.job, "csv", new Date()),
      text,
      "text/csv;charset=utf-8",
    );
    toast("CSV export started. Check your downloads.");
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function exportJson(): Promise<void> {
  if (!state.snapshot) {
    toast("There are no rows to export yet.", "error");
    return;
  }
  try {
    const audit = await sendMessage<AuditRecord[]>({ type: "job:audit", jobId: state.snapshot.job.id }).catch(
      () => [],
    );
    const payload = rowsToJson(state.rows, state.snapshot.job, APP_VERSION, new Date().toISOString(), audit);
    await downloadText(
      exportFilename("company-page-finder", state.snapshot.job, "json", new Date()),
      JSON.stringify(payload, null, 2),
      "application/json;charset=utf-8",
    );
    toast("JSON export started. Check your downloads.");
  } catch (error) {
    toast(errorMessage(error), "error");
  }
}

async function downloadText(filename: string, text: string, mime: string): Promise<void> {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      if (typeof chrome.downloads?.download !== "function") {
        reject(new Error("downloads_unavailable"));
        return;
      }
      chrome.downloads.download({ url, filename, saveAs: true }, (downloadId) => {
        const lastError = chrome.runtime.lastError;
        if (lastError || downloadId === undefined) {
          reject(new Error(lastError?.message ?? "Download failed."));
        } else {
          resolve();
        }
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message !== "downloads_unavailable") throw error;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

async function refresh(forceRows = false): Promise<void> {
  const previousKey = state.lastSnapshotKey;
  const previousJobId = state.snapshot?.job.id ?? null;
  const snapshot = await sendMessage<JobSnapshot | null>({ type: "job:latest" });

  if (!snapshot) {
    state.snapshot = null;
    state.rows = [];
    state.lastJobId = null;
    state.lastJobUpdatedAt = null;
    state.lastSnapshotKey = "";
    state.selected.clear();
    render();
    return;
  }

  let rowsChanged = false;
  if (forceRows || snapshot.job.id !== state.lastJobId || snapshot.job.updatedAt !== state.lastJobUpdatedAt) {
    state.rows = await sendMessage<ResultRow[]>({ type: "job:rows", jobId: snapshot.job.id });
    state.lastJobId = snapshot.job.id;
    state.lastJobUpdatedAt = snapshot.job.updatedAt;
    rowsChanged = true;
  }

  if (previousJobId !== snapshot.job.id) state.selected.clear();
  const rowIds = new Set(state.rows.map((row) => row.id));
  for (const id of [...state.selected]) if (!rowIds.has(id)) state.selected.delete(id);

  const key = [
    snapshot.job.id,
    snapshot.job.updatedAt,
    snapshot.job.state,
    snapshot.job.pauseReason ?? "",
    snapshot.stats.total,
    snapshot.stats.MATCHED,
    snapshot.stats.USER_CONFIRMED,
    snapshot.stats.REVIEW_REQUIRED,
    snapshot.stats.NOT_FOUND,
    snapshot.stats.ERROR,
    snapshot.stats.PENDING,
    snapshot.stats.IN_PROGRESS,
  ].join("|");
  state.snapshot = snapshot;
  state.lastSnapshotKey = key;
  if (rowsChanged || key !== previousKey) render();
}

async function poll(): Promise<void> {
  if (state.busy) return;
  try {
    await refresh(false);
  } catch {
    // A transient background/DB wake-up failure should not interrupt the page.
  }
}

let pasteTimer: ReturnType<typeof setTimeout> | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

function bindEvents(): void {
  for (const button of ui.modeButtons) {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode;
      if (mode === "person" || mode === "company") setMode(mode);
    });
  }

  ui.tabPaste.addEventListener("click", () => selectTab("paste"));
  ui.tabCsv.addEventListener("click", () => selectTab("csv"));
  ui.tabPaste.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") {
      selectTab("csv");
      ui.tabCsv.focus();
    }
  });
  ui.tabCsv.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") {
      selectTab("paste");
      ui.tabPaste.focus();
    }
  });

  ui.paste.addEventListener("input", () => {
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = setTimeout(updatePasteImport, 220);
  });

  ui.loadExample.addEventListener("click", () => {
    if (state.mode === "person") {
      ui.csvFileName.dataset["hasFile"] = "true";
      ui.csvFileName.dataset["text"] = PEOPLE_SAMPLE_CSV;
      ui.csvFileName.textContent = "people-example.csv";
      selectTab("csv");
      toast("Loaded a people example with company, title, and location context.");
      return;
    }
    ui.paste.value = "Microsoft\nExample Private Ltd\nAcme\nUmbrella\nInitech";
    selectTab("paste");
    ui.paste.focus();
  });

  ui.csvInput.addEventListener("change", () => {
    const file = ui.csvInput.files?.[0];
    if (file) void handleCsvFile(file);
    ui.csvInput.value = "";
  });

  for (const eventName of ["dragenter", "dragover"]) {
    ui.csvDrop.addEventListener(eventName, (event) => {
      event.preventDefault();
      ui.csvDrop.classList.add("is-dragging");
    });
  }
  for (const eventName of ["dragleave", "dragend"]) {
    ui.csvDrop.addEventListener(eventName, () => ui.csvDrop.classList.remove("is-dragging"));
  }
  ui.csvDrop.addEventListener("drop", (event) => {
    event.preventDefault();
    ui.csvDrop.classList.remove("is-dragging");
    const file = event.dataTransfer?.files?.[0];
    if (file) void handleCsvFile(file);
  });

  ui.downloadSample.addEventListener("click", () => {
    const sample = state.mode === "person" ? PEOPLE_SAMPLE_CSV : SAMPLE_CSV;
    const name = state.mode === "person" ? "people-sample.csv" : "company-sample.csv";
    void downloadText(name, `\uFEFF${sample}`, "text/csv;charset=utf-8");
  });

  ui.start.addEventListener("click", () => void startBatch());

  ui.pause.addEventListener("click", async () => {
    if (!state.snapshot) return;
    try {
      await sendMessage<Job>({ type: "job:pause", jobId: state.snapshot.job.id });
      await refresh(true);
      toast("Batch paused.");
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  });

  ui.resume.addEventListener("click", () => void resumeJob());

  ui.cancel.addEventListener("click", async () => {
    if (!state.snapshot) return;
    const confirmed = await askConfirm(
      "Cancel this batch?",
      "Remaining rows will not be searched. Results and evidence already collected stay available for export.",
      "Cancel batch",
    );
    if (!confirmed) return;
    try {
      await sendMessage<Job>({ type: "job:cancel", jobId: state.snapshot.job.id });
      await refresh(true);
      toast("Batch cancelled.");
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  });

  ui.newBatch.addEventListener("click", () => {
    ui.paste.focus();
    ui.paste.scrollIntoView({ behavior: "smooth", block: "center" });
    toast("Paste a new list or import a CSV to start another batch.");
  });

  for (const sorter of document.querySelectorAll<HTMLButtonElement>("button[data-sort]")) {
    sorter.addEventListener("click", () => {
      const key = sorter.dataset.sort as SortKey | undefined;
      if (!key) return;
      if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      else {
        state.sortKey = key;
        state.sortDir = "asc";
      }
      renderResults();
    });
  }

  ui.search.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = ui.search.value;
      state.page = 1;
      renderResults();
    }, 180);
  });

  ui.statusFilter.addEventListener("change", () => {
    state.filter = ui.statusFilter.value as StatusFilter;
    state.page = 1;
    renderResults();
  });

  ui.pageSize.addEventListener("change", () => {
    state.pageSize = Number(ui.pageSize.value);
    state.page = 1;
    renderResults();
  });

  ui.prev.addEventListener("click", () => {
    state.page = Math.max(1, state.page - 1);
    renderResults();
  });
  ui.next.addEventListener("click", () => {
    state.page += 1;
    renderResults();
  });

  ui.selectAll.addEventListener("change", () => {
    const page = paginate(
      sortRows(filterRows(state.rows, state.filter, state.query), state.sortKey, state.sortDir),
      state.page,
      state.pageSize,
    );
    for (const row of page.items) {
      if (ui.selectAll.checked) state.selected.add(row.id);
      else state.selected.delete(row.id);
    }
    renderResults();
  });

  ui.tbody.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[data-action]");
    if (!button) return;
    const rowId = button.dataset.rowId;
    if (!rowId) return;
    if (button.dataset.action === "review") void openReview(rowId);
    else if (button.dataset.action === "edit") openEdit(rowId);
  });

  ui.retryFailed.addEventListener("click", () => void retryFailed());
  ui.retrySelected.addEventListener("click", () => void retrySelected());
  ui.exportCsv.addEventListener("click", () => void exportCsv());
  ui.exportJson.addEventListener("click", () => void exportJson());

  ui.reviewClose.addEventListener("click", () => ui.reviewDialog.close());
  ui.reviewDialog.addEventListener("click", (event) => {
    if (event.target === ui.reviewDialog) ui.reviewDialog.close();
  });
  ui.reviewDialog.addEventListener("close", () => {
    state.reviewRowId = null;
  });

  ui.reviewBody.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(
      "button[data-review-action]",
    );
    if (!button) return;
    const url = button.dataset.url;
    const action = button.dataset.reviewAction;
    if (!url || !action) return;
    void handleReviewAction(action, url);
  });

  ui.editForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.editRowId || !state.snapshot) return;
    const editingRow = state.rows.find((entry) => entry.id === state.editRowId);
    const context =
      editingRow && rowKind(editingRow.raw) === "person"
        ? {
            company: ui.editPersonCompany.value.trim(),
            jobTitle: ui.editJobTitle.value.trim(),
            location: ui.editPersonLocation.value.trim(),
            email: ui.editEmail.value.trim(),
            phone: ui.editPhone.value.trim(),
            notes: ui.editNotes.value.trim(),
          }
        : {
            country: ui.editCountry.value.trim(),
            region: ui.editRegion.value.trim(),
            city: ui.editCity.value.trim(),
            officialDomain: ui.editDomain.value.trim(),
            officialWebsite: ui.editWebsite.value.trim(),
            alias: ui.editAlias.value.trim(),
            notes: ui.editNotes.value.trim(),
          };
    try {
      await sendMessage<ResultRow>({
        type: "row:update-context",
        jobId: state.snapshot.job.id,
        rowId: state.editRowId,
        context,
      });
      ui.editDialog.close();
      state.editRowId = null;
      await refresh(true);
      toast("Context saved. The lookup was re-queued.");
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  });
  ui.editClose.addEventListener("click", () => ui.editDialog.close());
  ui.editCancel.addEventListener("click", () => ui.editDialog.close());
  ui.editDialog.addEventListener("close", () => {
    state.editRowId = null;
  });
}

async function loadData(): Promise<void> {
  const [settings, info] = await Promise.all([
    sendMessage<AppSettings>({ type: "settings:get" }),
    sendMessage<AppInfo>({ type: "app:info" }),
  ]);
  state.settings = settings;
  state.info = info;
  renderBuildBadge();
  populateSelects();
  renderIntake();
  renderGlobalBanner();
  await refresh(true);
  if (state.snapshot?.job.mode && state.snapshot.job.mode !== state.mode) {
    state.mode = state.snapshot.job.mode;
    renderMode();
  }
}

async function init(): Promise<void> {
  bindEvents();
  await loadData();
  render();
  window.setInterval(() => {
    if (!document.hidden) void poll();
  }, 2000);
}

void init().catch((error: unknown) => {
  toast(errorMessage(error), "error");
});
