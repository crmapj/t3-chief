import { describe, expect, test } from "bun:test";

import { ScheduleConflictError, ScheduleLedger } from "../src/adapters/ledger.ts";
import type { ScheduleRequest } from "../src/domain/model.ts";

function request(prompt = "Review the open work."): ScheduleRequest {
  return {
    managerId: "chief",
    key: "daily-review",
    environment: "home",
    trigger: { kind: "cron", expression: "0 8 * * 1-5", timeZone: "Europe/Rome" },
    target: { kind: "existing-thread", threadId: "thread-1" },
    prompt,
    enabled: true,
    policy: { misfire: "latest", whenBusy: "defer" },
  };
}

describe("schedule ledger", () => {
  test("uses idempotent keys and compare-and-swap revisions", () => {
    using ledger = new ScheduleLedger(":memory:");

    const created = ledger.putSchedule(request());
    const replayed = ledger.putSchedule(request());

    expect(created).toEqual(replayed);
    expect(created.id).toStartWith("sch_");
    expect(created.revision).toBe(1);
    expect(() => ledger.putSchedule(request("Changed"))).toThrow(ScheduleConflictError);

    const replaced = ledger.putSchedule(request("Changed"), { expectedRevision: 1 });
    expect(replaced.revision).toBe(2);
    expect(replaced.prompt).toBe("Changed");
  });

  test("persists one deterministic occurrence intent before dispatch", () => {
    using ledger = new ScheduleLedger(":memory:");
    const schedule = ledger.putSchedule(request());

    const first = ledger.reserveOccurrence(schedule, {
      runKey: "2030-01-01T06:00:00.000Z",
      scheduledFor: "2030-01-01T06:00:00.000Z",
    });
    ledger.markOccurrence(first.id, "dispatching", { attemptCount: 1 });
    const replayed = ledger.reserveOccurrence(schedule, {
      runKey: "2030-01-01T06:00:00.000Z",
      scheduledFor: "2030-01-01T06:00:00.000Z",
    });

    expect(replayed.id).toBe(first.id);
    expect(replayed.commandId).toBe(first.commandId);
    expect(replayed.state).toBe("dispatching");
    expect(ledger.listRecoverableOccurrences().map((occurrence) => occurrence.id)).toEqual([
      first.id,
    ]);
  });

  test("normalizes persisted receipts and redacts diagnostic secrets", () => {
    using ledger = new ScheduleLedger(":memory:");
    const schedule = ledger.putSchedule(request());
    const occurrence = ledger.reserveOccurrence(schedule, {
      runKey: "2030-01-01T06:00:00.000Z",
      scheduledFor: "2030-01-01T06:00:00.000Z",
    });

    const saved = ledger.markOccurrence(occurrence.id, "accepted", {
      receipt: {
        commandId: "command-1",
        status: "accepted",
        sequence: 1,
        accessToken: "RECEIPT_SENTINEL_SECRET",
        nested: { private: "RECEIPT_SENTINEL_SECRET" },
      },
      lastError: "Bearer LAST_ERROR_SENTINEL_SECRET\nrequest failed",
    });

    expect(saved.receipt).toEqual({ commandId: "command-1", sequence: 1, status: "accepted" });
    expect(saved.lastError).toBe("Bearer [redacted] request failed");
    expect(JSON.stringify(saved)).not.toContain("SENTINEL_SECRET");
  });

  test("tombstones schedules but retains occurrence history", () => {
    using ledger = new ScheduleLedger(":memory:");
    const schedule = ledger.putSchedule(request());
    ledger.reserveOccurrence(schedule, {
      runKey: "manual:check-1",
      scheduledFor: "2030-01-01T09:00:00.000Z",
    });

    ledger.removeSchedule(schedule.id);

    expect(ledger.listSchedules()).toEqual([]);
    expect(ledger.listOccurrences({ scheduleId: schedule.id })).toEqual([
      expect.objectContaining({ state: "skipped", lastError: "Schedule removed before delivery." }),
    ]);
    expect(ledger.listRecoverableOccurrences()).toEqual([]);
  });

  test("caches a provider reading until it expires", () => {
    using ledger = new ScheduleLedger(":memory:");

    ledger.writeProviderLimit(
      "claude:work",
      { source: "probe" },
      "2030-01-01T18:40:00.000Z",
      "2030-01-01T18:45:00.000Z",
    );

    expect(ledger.readProviderLimit("claude:work", "2030-01-01T18:44:00.000Z")).toEqual({
      source: "probe",
    });
    expect(ledger.readProviderLimit("claude:work", "2030-01-01T18:46:00.000Z")).toBeNull();
    expect(ledger.readProviderLimit("claude:absent", "2030-01-01T18:40:00.000Z")).toBeNull();
  });

  test("reserves a provider endpoint once per cool-down and extends it on backoff", () => {
    using ledger = new ScheduleLedger(":memory:");

    expect(
      ledger.reserveProviderEndpoint(
        "claude/work",
        "2030-01-01T18:40:00.000Z",
        "2030-01-01T18:43:00.000Z",
      ),
    ).toBe(true);
    // A second process inside the interval must not probe as well.
    expect(
      ledger.reserveProviderEndpoint(
        "claude/work",
        "2030-01-01T18:41:00.000Z",
        "2030-01-01T18:44:00.000Z",
      ),
    ).toBe(false);
    expect(
      ledger.reserveProviderEndpoint(
        "claude/work",
        "2030-01-01T18:44:00.000Z",
        "2030-01-01T18:47:00.000Z",
      ),
    ).toBe(true);

    ledger.backOffProviderEndpoint(
      "claude/work",
      "2030-01-01T19:10:00.000Z",
      "usage-429",
      "2030-01-01T18:44:30.000Z",
    );
    expect(ledger.providerEndpointState("claude/work")).toEqual({
      nextAllowedAt: "2030-01-01T19:10:00.000Z",
      lastStatus: "usage-429",
    });
    // A shorter backoff never shortens a longer one already in force.
    ledger.backOffProviderEndpoint(
      "claude/work",
      "2030-01-01T18:50:00.000Z",
      "messages-429",
      "2030-01-01T18:45:00.000Z",
    );
    expect(ledger.providerEndpointState("claude/work")?.nextAllowedAt).toBe(
      "2030-01-01T19:10:00.000Z",
    );
  });
});
