import { readFileSync } from "node:fs";

/**
 * Minimal, dependency-free .env loader for local development.
 * Production hosts should inject real environment variables/secrets; existing
 * process environment values always win over the file.
 */
export function loadEnvFile(file: string): boolean {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return false;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  return true;
}
