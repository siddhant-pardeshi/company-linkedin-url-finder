import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const extensionRoot = path.join(root, "apps", "extension");

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

describe("extension manifest", () => {
  it("uses Manifest V3 with the documented minimal permission surface", async () => {
    const manifest = await readJson<Record<string, unknown>>(path.join(extensionRoot, "manifest.base.json"));
    expect(manifest["manifest_version"]).toBe(3);
    expect((manifest["permissions"] as string[]).sort()).toEqual(["alarms", "downloads", "storage"]);
    expect(manifest["content_scripts"]).toBeUndefined();
    expect(manifest["web_accessible_resources"]).toBeUndefined();
    expect(manifest["optional_host_permissions"]).toEqual([
      "https://generativelanguage.googleapis.com/*",
      "https://api.x.ai/*",
      "https://openrouter.ai/*",
    ]);
    expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
    expect(JSON.stringify(manifest)).not.toContain("linkedin.com");
  });

  it("requests exactly one build-time resolver host permission", async () => {
    const manifest = await readJson<Record<string, string[]>>(path.join(extensionRoot, "manifest.base.json"));
    expect(manifest["host_permissions"]).toEqual(["__RESOLVER_ORIGIN__/*"]);
  });

  it("sets a restrictive extension-page CSP", async () => {
    const manifest = await readJson<{ content_security_policy: { extension_pages: string } }>(
      path.join(extensionRoot, "manifest.base.json"),
    );
    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("unsafe-inline");
  });

  it("keeps the manifest version in sync with package.json", async () => {
    const manifest = await readJson<{ version: string }>(path.join(extensionRoot, "manifest.base.json"));
    const pkg = await readJson<{ version: string }>(path.join(root, "package.json"));
    expect(manifest.version).toBe(pkg.version);
  });

  it("requests no content script, tab, or automation capability", async () => {
    const manifest = await readJson<{ permissions: string[]; background: { service_worker: string } }>(
      path.join(extensionRoot, "manifest.base.json"),
    );
    for (const forbidden of [
      "tabs",
      "activeTab",
      "scripting",
      "webRequest",
      "history",
      "cookies",
      "debugger",
    ]) {
      expect(manifest.permissions).not.toContain(forbidden);
    }
    expect(manifest.background.service_worker).toBe("background/service-worker.js");
  });
});

describe("extension pages", () => {
  it("contains no inline executable script", async () => {
    for (const page of ["workspace.html", "options.html"]) {
      const html = await readFile(path.join(extensionRoot, "static", page), "utf8");
      const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
      expect(inlineScripts, page).toHaveLength(0);
      expect(html).toMatch(/<script type="module" src="js\/(workspace|options)\.js"><\/script>/);
    }
  });

  it("references only local, existing styles and icons", async () => {
    for (const page of ["workspace.html", "options.html"]) {
      const html = await readFile(path.join(extensionRoot, "static", page), "utf8");
      for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        const reference = match[1] ?? "";
        if (/^(https?:|#|data:)/.test(reference)) continue;
        if (reference.startsWith("js/")) continue; // bundled by tools/build-extension.mjs
        const full = path.join(extensionRoot, "static", reference);
        const content = await readFile(full).catch(() => null);
        expect(content, `${page} → ${reference}`).not.toBeNull();
      }
    }
  });

  it("has an accessible dialog and live region on the workspace", async () => {
    const html = await readFile(path.join(extensionRoot, "static", "workspace.html"), "utf8");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("<dialog");
    expect(html).toContain('id="select-all"');
    expect(html).toContain("skip-link");
  });
});

describe("extension source boundaries", () => {
  it("never imports test fixtures or provider secrets into the packaged extension", async () => {
    const files = await sourceFiles(path.join(extensionRoot, "src"));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toContain("@clf/fixtures");
      expect(source, file).not.toContain("api.search.brave.com");
      expect(source, file).not.toContain("X-Subscription-Token");
      expect(source, file).not.toContain("BRAVE_API_KEY");
    }
  });

  it("declares the documented external entry points", async () => {
    const worker = await readFile(path.join(extensionRoot, "src", "background", "service-worker.ts"), "utf8");
    expect(worker).toContain("chrome.alarms.create");
    expect(worker).toContain("chrome.action.onClicked");
    expect(worker).toContain("onInstalled");
    expect(worker).toContain("autoResumeIfReady");
  });
});
