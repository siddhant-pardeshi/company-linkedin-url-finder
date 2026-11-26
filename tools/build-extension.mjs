import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isDev = process.argv.includes("--dev");
const outDir = path.join(root, "dist", isDev ? "extension-dev" : "extension");
const extensionRoot = path.join(root, "apps", "extension");
const matchingEntry = path.join(root, "packages", "matching", "src", "index.ts");

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("RESOLVER_ORIGIN must use https (http is allowed only for localhost development).");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("RESOLVER_ORIGIN must be an origin only, for example https://resolver.example.com.");
  }
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "http:" && !localhost) {
    throw new Error("Production resolver origins must use https.");
  }
  return url.origin;
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

async function readVersion() {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  return String(pkg.version);
}

async function assertFile(file) {
  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile()) throw new Error(`Build is missing ${path.relative(root, file)}`);
}

async function main() {
  const version = await readVersion();
  const commit = gitCommit();
  const buildTime = new Date().toISOString();
  const originArg = argValue("origin") ?? process.env.RESOLVER_ORIGIN;
  const endpoint = isDev
    ? "http://127.0.0.1:8787"
    : normalizeOrigin(originArg ?? "https://resolver.example.com");
  if (!isDev && !originArg) {
    console.warn(
      "WARNING: RESOLVER_ORIGIN is not set; building with the placeholder https://resolver.example.com.\n" +
        "         Rebuild with RESOLVER_ORIGIN=https://your-resolver.example.com before store packaging.",
    );
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, "background"), { recursive: true });
  await mkdir(path.join(outDir, "js"), { recursive: true });

  const define = {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_ENV__: JSON.stringify(isDev ? "development" : "production"),
    __BUILD_COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(buildTime),
    __RESOLVER_ENDPOINT__: JSON.stringify(endpoint),
  };

  const common = {
    bundle: true,
    platform: "browser",
    target: ["chrome116"],
    format: "esm",
    define,
    alias: { "@clf/matching": matchingEntry },
    logLevel: "warning",
    legalComments: "none",
    banner: {
      js: `/* Company Page Finder v${version} — built ${buildTime} — commit ${commit} */`,
    },
  };

  await Promise.all([
    build({
      ...common,
      entryPoints: [path.join(extensionRoot, "src", "background", "service-worker.ts")],
      outfile: path.join(outDir, "background", "service-worker.js"),
    }),
    build({
      ...common,
      entryPoints: [path.join(extensionRoot, "src", "ui", "workspace.ts")],
      outfile: path.join(outDir, "js", "workspace.js"),
    }),
    build({
      ...common,
      entryPoints: [path.join(extensionRoot, "src", "ui", "options.ts")],
      outfile: path.join(outDir, "js", "options.js"),
    }),
  ]);

  await cp(path.join(extensionRoot, "static"), outDir, { recursive: true });

  const manifestTemplate = JSON.parse(await readFile(path.join(extensionRoot, "manifest.base.json"), "utf8"));
  const manifest = {
    ...manifestTemplate,
    version,
    host_permissions: [`${endpoint.replace(/\/+$/, "")}/*`],
  };
  await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  for (const file of [
    "manifest.json",
    "workspace.html",
    "options.html",
    "js/workspace.js",
    "js/options.js",
    "background/service-worker.js",
    "icons/icon-16.png",
    "icons/icon-32.png",
    "icons/icon-48.png",
    "icons/icon-128.png",
  ]) {
    await assertFile(path.join(outDir, file));
  }

  console.log(
    JSON.stringify(
      {
        built: path.relative(root, outDir),
        version,
        environment: isDev ? "development" : "production",
        endpoint,
        commit,
        buildTime,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
