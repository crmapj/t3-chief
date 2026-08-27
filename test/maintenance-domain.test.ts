import { describe, expect, test } from "bun:test";

import {
  maintenanceDispatchIds,
  parseSessionLimitReset,
  rateLimitDispatchIds,
} from "../src/domain/maintenance.ts";

describe("maintenance domain", () => {
  test("parses a same-day provider session reset", () => {
    expect(
      parseSessionLimitReset(
        "You've hit your session limit · resets 8:30pm (UTC)",
        "2026-08-25T18:35:00.000Z",
      ),
    ).toBe("2026-08-25T20:30:00.000Z");
  });

  test("rolls an earlier reset clock into the next UTC day", () => {
    expect(
      parseSessionLimitReset(
        "You've hit your session limit - resets 1:50am (UTC)",
        "2026-08-25T23:17:00.000Z",
      ),
    ).toBe("2026-08-26T01:50:00.000Z");
  });

  test("rejects loose or invalid provider text", () => {
    expect(parseSessionLimitReset("rate limited until later", "2026-08-25T18:35:00Z")).toBeNull();
    expect(
      parseSessionLimitReset(
        "You've hit your session limit · resets 13:70pm (UTC)",
        "2026-08-25T18:35:00Z",
      ),
    ).toBeNull();
  });

  test("derives stable, distinct command and message IDs", () => {
    const rateFirst = rateLimitDispatchIds("home", "assistant:1");
    const rateAgain = rateLimitDispatchIds("home", "assistant:1");
    const maintenance = maintenanceDispatchIds("window-1", "thread-1", "turn-1");

    expect(rateFirst).toEqual(rateAgain);
    expect(rateFirst.commandId).not.toBe(rateFirst.messageId);
    expect(maintenance.commandId).not.toBe(rateFirst.commandId);
    expect(rateFirst.commandId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
