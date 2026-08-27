import { describe, expect, test } from "bun:test";

import {
  deterministicOccurrenceIds,
  dueInstants,
  triggerExpired,
  validateTrigger,
} from "../src/domain/schedule.ts";

describe("schedule domain", () => {
  test("derives stable IDs from a schedule and nominal instant", () => {
    const first = deterministicOccurrenceIds("daily-review", "2026-08-27T08:00:00.000Z");
    const second = deterministicOccurrenceIds("daily-review", "2026-08-27T08:00:00.000Z");

    expect(first).toEqual(second);
    expect(first.occurrenceId).toStartWith("occ_");
    expect(first.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.commandId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("returns only the latest missed cron slot by default", () => {
    const result = dueInstants({
      trigger: { kind: "cron", expression: "0 * * * *", timeZone: "UTC" },
      after: "2026-08-27T05:00:00.000Z",
      now: "2026-08-27T08:30:00.000Z",
      misfire: "latest",
    });

    expect(result).toEqual(["2026-08-27T08:00:00.000Z"]);
  });

  test("allows normal timer jitter under skip policy but rejects stale slots", () => {
    const trigger = { kind: "cron" as const, expression: "0 * * * *", timeZone: "UTC" };
    expect(
      dueInstants({
        trigger,
        after: "2026-08-27T07:00:00.000Z",
        now: "2026-08-27T08:00:30.000Z",
        misfire: "skip",
      }),
    ).toEqual(["2026-08-27T08:00:00.000Z"]);
    expect(
      dueInstants({
        trigger,
        after: "2026-08-27T07:00:00.000Z",
        now: "2026-08-27T08:10:00.000Z",
        misfire: "skip",
      }),
    ).toEqual([]);
  });

  test("caps cron instants at the until bound, inclusive of the bound itself", () => {
    const trigger = {
      kind: "cron" as const,
      expression: "*/20 * * * *",
      timeZone: "UTC",
      until: "2026-08-27T10:00:00.000Z",
    };
    expect(
      dueInstants({
        trigger,
        after: "2026-08-27T09:59:00.000Z",
        now: "2026-08-27T10:00:05.000Z",
        misfire: "latest",
      }),
    ).toEqual(["2026-08-27T10:00:00.000Z"]);
    expect(
      dueInstants({
        trigger,
        after: "2026-08-27T10:00:00.000Z",
        now: "2026-08-27T11:00:00.000Z",
        misfire: "latest",
      }),
    ).toEqual([]);
  });

  test("reports cron expiry only after the until bound passes", () => {
    const trigger = {
      kind: "cron" as const,
      expression: "*/20 * * * *",
      timeZone: "UTC",
      until: "2026-08-27T10:00:00.000Z",
    };
    expect(triggerExpired(trigger, "2026-08-27T09:59:59.000Z")).toBe(false);
    expect(triggerExpired(trigger, "2026-08-27T10:00:01.000Z")).toBe(true);
    expect(
      triggerExpired({ kind: "once", at: "2026-08-27T10:00:00.000Z" }, "2027-01-01T00:00:00.000Z"),
    ).toBe(false);
  });

  test("validates RFC3339 once triggers and IANA cron zones", () => {
    expect(validateTrigger({ kind: "once", at: "tomorrow" })).toContain("RFC3339");
    expect(
      validateTrigger({ kind: "cron", expression: "0 8 * * *", timeZone: "Moon/Base" }),
    ).toContain("time zone");
    expect(
      validateTrigger({ kind: "cron", expression: "0 8 * * 1-5", timeZone: "Europe/Rome" }),
    ).toBeNull();
    expect(
      validateTrigger({ kind: "cron", expression: "0 8 * * *", timeZone: "UTC", until: "soon" }),
    ).toContain("RFC3339");
    expect(
      validateTrigger({
        kind: "cron",
        expression: "0 8 * * *",
        timeZone: "UTC",
        until: "2026-08-27T10:00:00.000Z",
      }),
    ).toBeNull();
  });
});
