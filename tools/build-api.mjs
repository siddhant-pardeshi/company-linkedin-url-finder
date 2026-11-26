import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const matchingEntry = path.join(root, "packages", "matching", "src", "index.ts");

build({
  entryPoints: [path.join(root, "apps", "api", "src", "main.ts")],
  bundle: true,
  platform: "node",
  target: ["node20"],
  format: "esm",
  outfile: path.join(root, "dist", "api", "server.js"),
  alias: { "@clf/matching": matchingEntry },
  legalComments: "none",
  logLevel: "warning",
  banner: {
    js: "/* Company Page Finder resolver — bundled. Secrets are read only from the environment. */",
  },
})
  .then(() => {
    console.log("Built dist/api/server.js");
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
