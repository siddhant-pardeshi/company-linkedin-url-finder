import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist", "extension");
const packages = path.join(root, "dist", "packages");
const allowUnconfigured = process.argv.includes("--allow-unconfigured");

function sha256(file) {
  return createHash("sha256").update(file).digest("hex");
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(dist, "manifest.json"), "utf8"));
  const host = manifest.host_permissions?.[0] ?? "";
  const placeholder = host.includes("resolver.example.com");
  if (placeholder && !allowUnconfigured) {
    throw new Error(
      "The extension was built with the placeholder resolver origin.\n" +
        "Rebuild with RESOLVER_ORIGIN=https://your-resolver.example.com, then run npm run package.\n" +
        "For a local QA artifact only, pass --allow-unconfigured.",
    );
  }

  execFileSync(process.execPath, [path.join(root, "tools", "validate-dist.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  await mkdir(packages, { recursive: true });

  const suffix = placeholder ? "-UNCONFIGURED" : "";
  const base = `company-page-finder-v${manifest.version}${suffix}`;
  const targets = [
    { name: `${base}-chrome.zip`, label: "Chrome" },
    { name: `${base}-edge.zip`, label: "Microsoft Edge" },
  ];

  const lines = [];
  const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  for (const target of targets) {
    const destination = path.join(packages, target.name);
    execFileSync(python, [path.join(root, "tools", "zip_dir.py"), dist, destination], {
      cwd: root,
      stdio: "inherit",
    });
    const digest = sha256(await readFile(destination));
    const size = (await stat(destination)).size;
    lines.push(`${digest}  ${target.name}  (${target.label}, ${(size / 1024).toFixed(1)} KiB)`);
    console.log(`${target.name}: sha256 ${digest}`);
  }

  await writeFile(path.join(packages, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
  const files = await readdir(packages);
  console.log(`\nPackages in ${path.relative(root, packages)}: ${files.join(", ")}`);
  if (placeholder) {
    console.log("\nWARNING: these are UNCONFIGURED QA artifacts. Do not submit them to a store.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
