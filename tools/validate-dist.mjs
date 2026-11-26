import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist", "extension");

const EXPECTED_PERMISSIONS = new Set(["storage", "alarms", "downloads"]);
const FORBIDDEN_API_PERMISSIONS = new Set([
  "tabs",
  "activeTab",
  "scripting",
  "webRequest",
  "history",
  "clipboardRead",
  "management",
  "cookies",
  "debugger",
  "proxy",
  "declarativeNetRequest",
  "notifications",
]);

const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

async function exists(file) {
  const info = await stat(file).catch(() => null);
  return Boolean(info?.isFile());
}

async function readText(file) {
  return readFile(file, "utf8");
}

async function main() {
  const manifestPath = path.join(dist, "manifest.json");
  check(await exists(manifestPath), "dist/extension/manifest.json is missing; run npm run build.");
  if (!(await exists(manifestPath))) throw new Error("Build output missing");

  const manifest = JSON.parse(await readText(manifestPath));
  const pkg = JSON.parse(await readText(path.join(root, "package.json")));

  check(manifest.manifest_version === 3, "manifest_version must be 3");
  check(
    manifest.version === pkg.version,
    `manifest version ${manifest.version} must match package.json ${pkg.version}`,
  );
  check(String(manifest.name).length <= 75, "extension name exceeds 75 characters");
  check(String(manifest.description).length <= 132, "extension description exceeds 132 characters");
  check(Number(manifest.minimum_chrome_version) >= 116, "minimum_chrome_version must be at least 116");

  for (const permission of manifest.permissions ?? []) {
    check(EXPECTED_PERMISSIONS.has(permission), `unexpected API permission: ${permission}`);
    check(!FORBIDDEN_API_PERMISSIONS.has(permission), `forbidden API permission: ${permission}`);
  }
  check(
    new Set(manifest.permissions ?? []).size === EXPECTED_PERMISSIONS.size,
    "expected exactly storage, alarms, and downloads permissions",
  );

  const hosts = manifest.host_permissions ?? [];
  check(hosts.length === 1, `expected exactly one host permission, found ${hosts.length}`);
  for (const host of hosts) {
    check(!/linkedin/i.test(host), `LinkedIn host permission is forbidden: ${host}`);
    check(!host.includes("<all_urls>"), "<all_urls> host permission is forbidden");
    check(
      /^https?:\/\/[a-z0-9.-]+(:\d+)?\/\*$/i.test(host),
      `host permission must be a narrow origin pattern: ${host}`,
    );
  }

  const optionalHosts = manifest.optional_host_permissions ?? [];
  const allowedOptionalHosts = new Set([
    "https://generativelanguage.googleapis.com/*",
    "https://api.x.ai/*",
    "https://openrouter.ai/*",
  ]);
  check(optionalHosts.length <= 3, "unexpected number of optional host permissions");
  for (const host of optionalHosts) {
    check(allowedOptionalHosts.has(host), `unexpected optional host permission: ${host}`);
  }

  check(!manifest.content_scripts, "content scripts are not part of this extension");
  check(!manifest.web_accessible_resources, "web accessible resources are not needed");

  const csp = manifest.content_security_policy?.extension_pages ?? "";
  check(csp.includes("script-src 'self'"), "extension CSP must restrict script-src to self");
  check(!csp.includes("unsafe-eval"), "extension CSP must not allow unsafe-eval");
  check(!csp.includes("unsafe-inline"), "extension CSP must not allow unsafe-inline scripts");

  for (const file of [
    "background/service-worker.js",
    "js/workspace.js",
    "js/options.js",
    "workspace.html",
    "options.html",
    "styles/base.css",
    "styles/workspace.css",
    "styles/options.css",
    "icons/icon-16.png",
    "icons/icon-32.png",
    "icons/icon-48.png",
    "icons/icon-128.png",
  ]) {
    check(await exists(path.join(dist, file)), `missing build file: ${file}`);
  }

  const jsFiles = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".js")) jsFiles.push(full);
    }
  }
  await walk(dist);

  for (const file of jsFiles) {
    const source = await readText(file);
    const relative = path.relative(dist, file);
    check(!/\beval\s*\(/.test(source), `eval() found in ${relative}`);
    check(!/\bnew\s+Function\s*\(/.test(source), `new Function() found in ${relative}`);
    check(!/X-Subscription-Token/i.test(source), `provider credential header leaked into ${relative}`);
    check(!/api\.search\.brave\.com/i.test(source), `provider endpoint leaked into ${relative}`);
    check(!/BRAVE_API_KEY/.test(source), `provider secret name leaked into ${relative}`);
  }

  // Every referenced local asset must exist.
  for (const html of ["workspace.html", "options.html"]) {
    const source = await readText(path.join(dist, html));
    for (const match of source.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const reference = match[1];
      if (!reference || /^(https?:|#|data:)/.test(reference)) continue;
      check(await exists(path.join(dist, reference)), `${html} references a missing file: ${reference}`);
    }
  }

  if (failures.length > 0) {
    console.error("Distribution validation failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(
    `Validated ${path.relative(root, dist)} — MV3, ${manifest.permissions.join("+")}, host ${hosts[0]}, ${jsFiles.length} bundled JS file(s).`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
