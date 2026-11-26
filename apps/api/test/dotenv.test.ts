import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFile } from "../src/dotenv.js";

const created: string[] = [];

function tempEnv(content: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "cpf-env-"));
  created.push(directory);
  const file = path.join(directory, ".env");
  writeFileSync(file, content, "utf8");
  return file;
}

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("loadEnvFile", () => {
  it("loads values without overriding existing environment variables", () => {
    process.env["CPF_TEST_EXISTING"] = "keep";
    try {
      const file = tempEnv(
        [
          "# comment",
          "CPF_TEST_NEW=value",
          'CPF_TEST_QUOTED="quoted value"',
          "CPF_TEST_EXISTING=override",
          "bad line",
          "=nokey",
        ].join("\n"),
      );
      expect(loadEnvFile(file)).toBe(true);
      expect(process.env["CPF_TEST_NEW"]).toBe("value");
      expect(process.env["CPF_TEST_QUOTED"]).toBe("quoted value");
      expect(process.env["CPF_TEST_EXISTING"]).toBe("keep");
    } finally {
      delete process.env["CPF_TEST_NEW"];
      delete process.env["CPF_TEST_QUOTED"];
      delete process.env["CPF_TEST_EXISTING"];
    }
  });

  it("returns false for a missing file", () => {
    expect(loadEnvFile(path.join(tmpdir(), "definitely-missing-cpf-env"))).toBe(false);
  });
});
