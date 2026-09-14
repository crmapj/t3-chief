import { describe, expect, test } from "bun:test";

import { parseDuration } from "../src/domain/duration.ts";

describe("duration parsing", () => {
  test("converts every supported unit to milliseconds", () => {
    expect(parseDuration("45s", "--stale")).toBe(45_000);
    expect(parseDuration("90m", "--stale")).toBe(5_400_000);
    expect(parseDuration("12h", "--stale")).toBe(43_200_000);
    expect(parseDuration("3d", "--stale")).toBe(259_200_000);
    expect(parseDuration("2w", "--stale")).toBe(1_209_600_000);
  });

  test("ignores surrounding whitespace", () => {
    expect(parseDuration("  6h  ", "--since")).toBe(21_600_000);
  });

  test("rejects a bare number, because its unit would be a guess", () => {
    expect(() => parseDuration("30", "--stale")).toThrow("--stale expects a duration like");
  });

  test("rejects zero, a negative, a fraction, an unknown unit, and a compound value", () => {
    for (const value of ["0d", "-1d", "1.5h", "7y", "1h30m", "", "d"]) {
      expect(() => parseDuration(value, "--since")).toThrow("--since expects a duration");
    }
  });

  test("rejects a duration that would not survive millisecond arithmetic", () => {
    expect(() => parseDuration("999999999w", "--stale")).toThrow("shorter duration");
  });
});
