import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, hasUsableToken, maskToken, validateSettings } from "../src/settings.js";

const valid = {
  accessToken: "test-token-0123456789abcdef",
  operatorName: "Local user",
  batchSize: 5,
  retentionDays: 30,
};

describe("validateSettings", () => {
  it("accepts a valid settings object and trims values", () => {
    const result = validateSettings({
      ...valid,
      accessToken: `  ${valid.accessToken}  `,
      operatorName: "  Ana  ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings.accessToken).toBe(valid.accessToken);
      expect(result.settings.operatorName).toBe("Ana");
    }
  });

  it("rejects short, empty, or whitespace-containing tokens", () => {
    for (const accessToken of ["", "short", "test token with spaces 1234"]) {
      const result = validateSettings({ ...valid, accessToken });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects invalid batch sizes and retention windows", () => {
    for (const batchSize of [0, 11, 2.5]) {
      expect(validateSettings({ ...valid, batchSize }).ok).toBe(false);
    }
    for (const retentionDays of [-1, 366, 1.5]) {
      expect(validateSettings({ ...valid, retentionDays }).ok).toBe(false);
    }
  });

  it("rejects an empty operator name", () => {
    expect(validateSettings({ ...valid, operatorName: "   " }).ok).toBe(false);
  });

  it("falls back to defaults for missing fields", () => {
    const result = validateSettings({ accessToken: valid.accessToken }, DEFAULT_SETTINGS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings.batchSize).toBe(DEFAULT_SETTINGS.batchSize);
      expect(result.settings.retentionDays).toBe(DEFAULT_SETTINGS.retentionDays);
      expect(result.settings.operatorName).toBe(DEFAULT_SETTINGS.operatorName);
    }
  });

  it("rejects non-object payloads", () => {
    expect(validateSettings(null).ok).toBe(false);
    expect(validateSettings([]).ok).toBe(false);
  });
});

describe("token helpers", () => {
  it("detects usable tokens", () => {
    expect(hasUsableToken({ ...DEFAULT_SETTINGS, accessToken: "1234567890123456" })).toBe(true);
    expect(hasUsableToken({ ...DEFAULT_SETTINGS, accessToken: "123456789012345" })).toBe(false);
    expect(hasUsableToken({ ...DEFAULT_SETTINGS, accessToken: "" })).toBe(false);
    expect(hasUsableToken({ ...DEFAULT_SETTINGS, accessToken: "123456789012345 6" })).toBe(false);
  });

  it("masks all but the last four characters", () => {
    expect(maskToken("abcdefghijklmnop")).toBe("••••mnop");
    expect(maskToken("abc")).toBe("••••");
  });
});
