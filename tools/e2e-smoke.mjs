/**
 * Real-browser smoke test over the Chrome DevTools Protocol.
 *
 * Usage: start Chrome for Testing with the unpacked dev build and
 * --remote-debugging-port=9223, then run `node tools/e2e-smoke.mjs`.
 * Requires the local mock resolver on http://127.0.0.1:8787.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const CDP = process.env.CDP_URL ?? "http://127.0.0.1:9223";
const TOKEN = process.env.TEST_TOKEN ?? "local-dev-token-1234567890";
const SHOTS = path.resolve(".zwork", "screenshots");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      if (message.method) {
        for (const handler of this.listeners.get(message.method) ?? []) handler(message.params);
      }
    });
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  on(method, handler) {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

const failures = [];
const passes = [];
const browserErrors = [];

function check(condition, message) {
  if (condition) passes.push(message);
  else failures.push(message);
}

async function main() {
  const targets = await (await fetch(`${CDP}/json/list`)).json();
  const page = targets.find((target) => target.type === "page" && target.url.includes("workspace.html"));
  if (!page) throw new Error("Open the extension workspace first (no workspace.html target found).");
  const extensionId = new URL(page.url).host;
  const base = `chrome-extension://${extensionId}`;

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Log.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });

  cdp.on("Runtime.exceptionThrown", (params) => {
    const detail = params.exceptionDetails;
    browserErrors.push(`exception: ${detail.text} ${detail.exception?.description ?? ""}`);
  });
  cdp.on("Runtime.consoleAPICalled", (params) => {
    if (params.type !== "error") return;
    browserErrors.push(
      `console.error: ${params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ")}`,
    );
  });
  cdp.on("Log.entryAdded", (params) => {
    if (params.entry.level === "error") browserErrors.push(`log: ${params.entry.text}`);
  });

  async function evaluate(expression) {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async function waitFor(expression, description, timeoutMs = 30_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        if (await evaluate(expression)) return;
      } catch {
        // Navigation can invalidate the context; retry.
      }
      await sleep(200);
    }
    throw new Error(`Timed out waiting for ${description}`);
  }

  async function navigate(url) {
    await cdp.send("Page.navigate", { url });
    await waitFor("document.readyState === 'complete'", `load ${url}`).catch(() => undefined);
    await sleep(400);
  }

  async function screenshot(name, options = {}) {
    if (options.scroll) {
      await evaluate(
        `document.querySelector(${JSON.stringify(options.scroll)})?.scrollIntoView({ block: 'start' })`,
      );
    } else if (options.scrollTop !== false) {
      await evaluate("window.scrollTo(0, 0)");
    }
    await sleep(350);
    await mkdir(SHOTS, { recursive: true });
    const result = await cdp.send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(SHOTS, name), Buffer.from(result.data, "base64"));
  }

  // Clean slate (fresh token, no old jobs), then reload the workspace.
  await navigate(`${base}/workspace.html`);
  await evaluate("chrome.runtime.sendMessage({ type: 'data:clear-all' })");
  await navigate(`${base}/workspace.html`);

  check(await evaluate("document.title.includes('Company Page Finder')"), "Workspace page loads");
  check(await evaluate("Boolean(document.querySelector('#start-button'))"), "Workspace shell renders");
  check(
    await evaluate("document.querySelector('#token-hint').hidden === false"),
    "Missing-token guidance is visible",
  );
  check(
    await evaluate("document.querySelector('#start-button').disabled === true"),
    "Start is disabled without a token",
  );
  check(
    await evaluate("document.querySelector('#build-badge').textContent.includes('Dev')"),
    "Development build badge is visible",
  );
  await screenshot("workspace-top.png");

  // Configure the token through the real options page.
  await navigate(`${base}/options.html`);
  await evaluate(`
    (() => {
      const input = document.querySelector('#token-input');
      input.value = ${JSON.stringify(TOKEN)};
      document.querySelector('#token-form').requestSubmit();
      return true;
    })()
  `);
  await waitFor(
    "document.querySelector('#connection-state').textContent.includes('Saved')",
    "token save",
    10_000,
  );
  check(
    await evaluate("document.querySelector('#connection-state').textContent.includes('Saved')"),
    "Options page saves the token",
  );

  await evaluate("document.querySelector('#test-connection').click()");
  await waitFor(
    "document.querySelector('#connection-state').textContent.includes('Connected')",
    "connection test",
    15_000,
  );
  check(
    await evaluate("document.querySelector('#connection-state').textContent.includes('Connected')"),
    "Resolver connection test succeeds",
  );
  check(
    await evaluate("document.querySelector('#settings-banner').textContent.includes('provider: mock')"),
    "Connection test reports the mock provider",
  );
  check(
    await evaluate(
      "document.querySelector('#ai-provider').value === 'gemini' && document.querySelector('#ai-state').textContent === 'Off'",
    ),
    "AI assist is present, off by default, and defaults to Gemini",
  );
  await evaluate("document.querySelector('#ai-heading').scrollIntoView({ block: 'start' })");
  await screenshot("options-ai.png", { scrollTop: false });
  await screenshot("options.png", { scrollTop: true });

  // Paste the demo list and start the batch.
  await navigate(`${base}/workspace.html`);
  await evaluate(`
    (() => {
      const textarea = document.querySelector('#paste-input');
      textarea.value = 'Microsoft\\nExample Private Ltd\\nAcme\\nUmbrella\\nInitech';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await waitFor("document.querySelectorAll('#import-summary .chip').length > 0", "import summary", 5000);
  check(
    await evaluate("document.querySelector('#start-button').disabled === false"),
    "Start enables with a valid pasted list",
  );
  check(
    await evaluate(
      "[...document.querySelectorAll('#import-summary .chip')].some((chip) => chip.textContent.includes('5 valid rows'))",
    ),
    "Import summary counts five valid rows",
  );

  await evaluate("document.querySelector('#start-button').click()");
  await waitFor(
    "document.querySelector('#job-state').textContent === 'Completed'",
    "batch completion",
    40_000,
  );
  check(
    await evaluate("document.querySelector('#job-state').textContent === 'Completed'"),
    "Batch completes end to end",
  );

  const values = await evaluate("[...document.querySelectorAll('.stat__value')].map((el) => el.textContent)");
  check(
    JSON.stringify(values) === JSON.stringify(["5", "2", "2", "1", "0", "0"]),
    `Stats are correct: ${values.join("/")}`,
  );

  const rowCount = await evaluate("document.querySelectorAll('#results-body tr').length");
  check(rowCount === 5, "All five original rows are rendered");
  check(
    await evaluate(`
      [...document.querySelectorAll('#results-body tr')].some((row) =>
        row.querySelector('.company-cell strong')?.textContent === 'Microsoft' &&
        row.textContent.includes('High-confidence match') &&
        row.querySelector('a')?.href === 'https://www.linkedin.com/company/microsoft/'
      )
    `),
    "Microsoft is high-confidence with the discovered canonical URL",
  );
  check(
    await evaluate(`
      [...document.querySelectorAll('#results-body tr')].some((row) =>
        row.querySelector('.company-cell strong')?.textContent === 'Acme' && row.textContent.includes('Review required')
      )
    `),
    "Acme is routed to review",
  );
  check(
    await evaluate(`
      [...document.querySelectorAll('#results-body tr')].some((row) =>
        row.querySelector('.company-cell strong')?.textContent === 'Initech' && row.textContent.includes('Not found')
      )
    `),
    "Initech is not found",
  );
  await screenshot("workspace-results.png", { scroll: "#results-section" });

  // Review and accept one Acme candidate.
  await evaluate(`
    (() => {
      const row = [...document.querySelectorAll('#results-body tr')].find((entry) =>
        entry.querySelector('.company-cell strong')?.textContent === 'Acme'
      );
      row.querySelector('button[data-action="review"]').click();
      return true;
    })()
  `);
  await waitFor("document.querySelector('#review-dialog').open === true", "review drawer", 5000);
  check(
    await evaluate("document.querySelectorAll('#review-dialog .candidate').length === 2"),
    "Review drawer shows both candidates",
  );
  check(
    await evaluate("document.querySelector('#review-dialog').textContent.includes('Provider queries')"),
    "Review drawer shows the provider queries and evidence",
  );
  await screenshot("review-drawer.png", { scrollTop: true });

  await evaluate(
    "document.querySelector('#review-dialog .candidate button[data-review-action=\"accept\"]').click()",
  );
  await waitFor(
    "[...document.querySelectorAll('#results-body tr')].some((row) => row.querySelector('.company-cell strong')?.textContent === 'Acme' && row.textContent.includes('User confirmed'))",
    "user confirmation",
    10_000,
  );
  check(
    await evaluate(`
      [...document.querySelectorAll('#results-body tr')].some((row) =>
        row.querySelector('.company-cell strong')?.textContent === 'Acme' &&
        row.querySelector('a')?.href.startsWith('https://www.linkedin.com/company/acme')
      )
    `),
    "Accepted candidate sets the selected URL",
  );
  check(
    await evaluate(
      "[...document.querySelectorAll('#review-dialog .audit-list li')].some((item) => item.textContent.includes('candidate accepted'))",
    ),
    "Human confirmation is written to the audit trail",
  );

  await evaluate("document.querySelector('#review-close').click()");

  // A different viewport to verify responsive layout doesn't break the table.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(300);
  check(
    await evaluate("getComputedStyle(document.querySelector('#results-body tr')).display === 'grid'"),
    "Narrow viewport switches results to readable cards",
  );
  check(
    await evaluate(
      "document.querySelector('.table-wrap').scrollWidth <= document.querySelector('.table-wrap').clientWidth + 1",
    ),
    "Narrow viewport has no horizontal table overflow",
  );
  await screenshot("workspace-narrow.png", { scroll: "#results-section" });

  // Person mode: CSV with context → deterministic /in/ matching.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await navigate(`${base}/workspace.html`);
  await evaluate("document.querySelector('button[data-mode=\"person\"]').click()");
  check(
    await evaluate("document.querySelector('#paste-label').textContent.includes('Full names')"),
    "People mode switches the input labels",
  );
  await evaluate("document.querySelector('#load-example').click()");
  await waitFor(
    "document.querySelectorAll('#import-summary .chip').length > 0",
    "people import summary",
    5000,
  );
  check(
    await evaluate(
      "[...document.querySelectorAll('#import-summary .chip')].some((chip) => chip.textContent.includes('4 valid rows'))",
    ),
    "People example imports four rows",
  );
  check(
    await evaluate("document.querySelector('#start-button').disabled === false"),
    "People batch can start",
  );
  await evaluate("document.querySelector('#start-button').click()");
  await waitFor(
    "document.querySelector('#job-meta').textContent.includes('People') && document.querySelector('#job-state').textContent === 'Completed'",
    "people batch completion",
    40_000,
  );
  const peopleStats = await evaluate(
    "[...document.querySelectorAll('.stat__value')].map((el) => el.textContent)",
  );
  check(
    JSON.stringify(peopleStats) === JSON.stringify(["4", "2", "1", "1", "0", "0"]),
    `People stats are correct: ${peopleStats.join("/")}`,
  );
  check(
    await evaluate("document.querySelector('#company-column-label').textContent === 'Person'"),
    "Results table relabels the name column for people",
  );
  check(
    await evaluate(`
      [...document.querySelectorAll('#results-body tr')].some((row) =>
        row.querySelector('.company-cell strong')?.textContent === 'Ada Lovelace' &&
        row.querySelector('a')?.href === 'https://www.linkedin.com/in/ada-lovelace/'
      )
    `),
    "Ada Lovelace resolves to the validated /in/ profile",
  );
  await evaluate(`
    (() => {
      const row = [...document.querySelectorAll('#results-body tr')].find((entry) =>
        entry.querySelector('.company-cell strong')?.textContent === 'Alan Turing'
      );
      row.querySelector('button[data-action="review"]').click();
      return true;
    })()
  `);
  await waitFor("document.querySelector('#review-dialog').open === true", "people review drawer", 5000);
  check(
    await evaluate("document.querySelectorAll('#review-dialog .candidate').length === 2"),
    "People review drawer shows both exact-name candidates",
  );
  await evaluate("document.querySelector('#review-close').click()");
  await screenshot("workspace-people.png", { scroll: "#results-section" });

  const uniqueErrors = [...new Set(browserErrors)].filter(
    (message) => !message.includes("favicon") && !message.includes("net::ERR"),
  );
  check(
    uniqueErrors.length === 0,
    `No browser console errors${uniqueErrors.length ? `: ${uniqueErrors.join(" | ")}` : ""}`,
  );

  cdp.close();

  console.log(passes.map((message) => `PASS  ${message}`).join("\n"));
  if (failures.length > 0) {
    console.error(failures.map((message) => `FAIL  ${message}`).join("\n"));
    process.exit(1);
  }
  console.log(`\n${passes.length} browser checks passed. Screenshots: ${SHOTS}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
