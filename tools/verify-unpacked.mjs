import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Preflight for "Load unpacked".
 *
 * Chrome must be pointed at a folder that contains manifest.json directly.
 * This repository writes builds to dist/extension (production) and
 * dist/extension-dev (local resolver); dist/ itself is only a container.
 *
 * Usage:
 *   node tools/verify-unpacked.mjs                # check known build folders
 *   node tools/verify-unpacked.mjs <folder> ...    # check any folder(s)
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const known = ["dist/extension", "dist/extension-dev"].map((entry) => path.join(root, entry));

const targets =
  process.argv.slice(2).length > 0 ? process.argv.slice(2).map((entry) => path.resolve(entry)) : known;

const RELATIVE_PATTERN = /(?:src|href)\s*=\s*["']([^"'#?]+)["']/g;

async function isFile(file) {
  const info = await stat(file).catch(() => null);
  return Boolean(info?.isFile());
}

async function isDirectory(dir) {
  const info = await stat(dir).catch(() => null);
  return Boolean(info?.isDirectory());
}

function manifestPaths(manifest) {
  const paths = new Set();
  if (manifest.background?.service_worker) paths.add(manifest.background.service_worker);
  for (const script of manifest.background?.scripts ?? []) paths.add(script);
  const action = manifest.action ?? manifest.browser_action ?? {};
  if (action.default_popup) paths.add(action.default_popup);
  if (manifest.options_ui?.page) paths.add(manifest.options_ui.page);
  if (manifest.options_page) paths.add(manifest.options_page);
  if (manifest.devtools_page) paths.add(manifest.devtools_page);
  for (const icon of Object.values(manifest.icons ?? {})) paths.add(icon);
  for (const icon of Object.values(action.default_icon ?? {})) paths.add(icon);
  for (const resource of manifest.web_accessible_resources ?? []) {
    for (const file of resource.resources ?? []) if (!file.includes("*")) paths.add(file);
  }
  return [...paths].filter((entry) => typeof entry === "string" && entry.length > 0);
}

async function verify(folder) {
  const problems = [];
  const label = path.relative(root, folder) || folder;

  if (!(await isDirectory(folder))) {
    return { folder, label, problems: ["folder does not exist"], loaded: false, summary: null };
  }

  const manifestPath = path.join(folder, "manifest.json");
  if (!(await isFile(manifestPath))) {
    const hint = (await isFile(path.join(folder, "extension", "manifest.json")))
      ? " This looks like a container folder; load the extension subfolder instead."
      : "";
    return {
      folder,
      label,
      problems: [`manifest.json is missing at the folder root.${hint}`],
      loaded: false,
      summary: null,
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    return {
      folder,
      label,
      problems: [`manifest.json is not valid JSON: ${error.message}`],
      loaded: false,
      summary: null,
    };
  }

  if (manifest.manifest_version !== 3)
    problems.push(`manifest_version is ${manifest.manifest_version}, expected 3`);
  if (!manifest.name) problems.push("manifest is missing a name");
  if (!manifest.version) problems.push("manifest is missing a version");

  for (const relative of manifestPaths(manifest)) {
    const file = path.join(folder, relative.replace(/^\//, ""));
    if (!(await isFile(file))) problems.push(`referenced file is missing: ${relative}`);
  }

  for (const page of [manifest.action?.default_popup, manifest.options_ui?.page]) {
    if (!page) continue;
    const file = path.join(folder, page.replace(/^\//, ""));
    const html = await readFile(file, "utf8").catch(() => "");
    for (const match of html.matchAll(RELATIVE_PATTERN)) {
      const target = match[1];
      if (!target || /^(https?:|data:|mailto:|#)/i.test(target) || target.startsWith("//")) continue;
      const resolved = path.join(path.dirname(file), target.replace(/^\//, ""));
      if (!(await isFile(resolved))) problems.push(`${page} references a missing file: ${target}`);
    }
  }

  const csp = manifest.content_security_policy?.extension_pages ?? "";
  if (!csp.includes("script-src 'self'"))
    problems.push("extension_pages CSP must restrict script-src to 'self'");
  if (csp.includes("unsafe-eval") || csp.includes("unsafe-inline")) {
    problems.push("extension_pages CSP must not allow unsafe-eval or unsafe-inline");
  }

  return {
    folder,
    label,
    problems,
    loaded: problems.length === 0,
    summary: {
      name: manifest.name,
      version: manifest.version,
      serviceWorker: manifest.background?.service_worker ?? "(none)",
      host: manifest.host_permissions?.[0] ?? "(none)",
      optionalHosts: (manifest.optional_host_permissions ?? []).length,
      icons: Object.keys(manifest.icons ?? {}).length,
    },
  };
}

const results = [];
for (const folder of targets) results.push(await verify(folder));

let failed = false;
for (const result of results) {
  if (result.loaded) {
    console.log(`OK    ${result.label}`);
    console.log(`      name: ${result.summary.name} v${result.summary.version}`);
    console.log(`      service worker: ${result.summary.serviceWorker}`);
    console.log(`      resolver host: ${result.summary.host}`);
    console.log(`      optional AI hosts: ${result.summary.optionalHosts}; icons: ${result.summary.icons}`);
    console.log(`      Load unpacked from: ${result.folder}`);
  } else {
    failed = true;
    console.log(`FAIL  ${result.label}`);
    for (const problem of result.problems) console.log(`      ${problem}`);
  }
  console.log("");
}

if (failed) {
  const containers = results.filter(
    (result) => !result.loaded && result.problems.some((p) => p.includes("container")),
  );
  if (containers.length > 0) {
    console.log(
      "A container folder such as dist/ cannot be loaded. Use dist/extension or dist/extension-dev.",
    );
  }
  process.exit(1);
}

console.log("All checked folders are loadable as unpacked extensions.");
