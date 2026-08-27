import { describe, expect, test } from "bun:test";

import { ScheduleLedger } from "../src/adapters/ledger.ts";
import type { ModelSelection, ProviderCatalog } from "../src/adapters/t3-v1.ts";
import { Scheduler, type SchedulerT3Port } from "../src/core/scheduler.ts";
import type { ScheduleRequest } from "../src/domain/model.ts";

const selection: ModelSelection = {
  instanceId: "codex",
  model: "gpt-test",
  options: [{ id: "reasoningEffort", value: "high" }],
};

const catalog: ProviderCatalog = {
  observedAt: "2026-08-27T07:00:00.000Z",
  fingerprint: "a".repeat(64),
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      status: "ready",
      models: [
        {
          slug: "gpt-test",
          name: "GPT Test",
          isDefault: true,
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: [{ id: "low" }, { id: "high" }],
            },
          ],
        },
      ],
    },
  ],
};

class FakeT3 implements SchedulerT3Port {
  busy = false;
  failAfterAcceptOnce = false;
  failBeforeAcceptOnce = false;
  permanentlyRejectedOnce = false;
  catalogCalls = 0;
  commands: Array<Record<string, unknown>> = [];
  messages = new Map<string, Array<Record<string, unknown>>>();

  async catalog(): Promise<ProviderCatalog> {
    this.catalogCalls += 1;
    return catalog;
  }

  async shell(): Promise<unknown> {
    return {
      projects: [{ id: "project-1", title: "Project", workspaceRoot: "/work/project" }],
      threads: [
        {
          id: "thread-1",
          projectId: "project-1",
          title: "Existing",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          latestTurn: { state: this.busy ? "running" : "completed" },
          session: { status: this.busy ? "running" : "idle" },
          hasPendingApprovals: false,
          hasPendingUserInput: false,
        },
      ],
    };
  }

  async thread(threadId: string): Promise<unknown> {
    return { thread: { id: threadId, messages: this.messages.get(threadId) ?? [] } };
  }

  async dispatch(command: Record<string, unknown>): Promise<unknown> {
    this.commands.push(command);
    if (this.permanentlyRejectedOnce) {
      this.permanentlyRejectedOnce = false;
      throw new Error("OrchestrationCommandPreviouslyRejectedError: Command previously rejected");
    }
    if (this.failBeforeAcceptOnce) {
      this.failBeforeAcceptOnce = false;
      throw new Error("connection lost before accept");
    }
    const threadId = String(command.threadId);
    const message = command.message as Record<string, unknown>;
    this.messages.set(threadId, [{ id: message.messageId, role: "user", text: message.text }]);
    if (this.failAfterAcceptOnce) {
      this.failAfterAcceptOnce = false;
      throw new Error("connection lost after accept");
    }
    return { sequence: this.commands.length };
  }
}

function newThreadRequest(): ScheduleRequest {
  return {
    managerId: "chief",
    key: "daily-audit",
    environment: "home",
    trigger: { kind: "cron", expression: "0 8 * * *", timeZone: "UTC" },
    target: {
      kind: "new-thread",
      projectId: "project-1",
      title: "Daily audit",
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      checkout: { kind: "project-workspace" },
    },
    prompt: "Audit the current state and report concrete findings.",
    enabled: true,
    policy: { misfire: "latest", whenBusy: "defer" },
  };
}

function existingThreadRequest(): ScheduleRequest {
  return {
    ...newThreadRequest(),
    key: "existing-follow-up",
    trigger: { kind: "once", at: "2026-08-27T08:00:00.000Z" },
    target: { kind: "existing-thread", threadId: "thread-1" },
  };
}

describe("scheduler", () => {
  test("validates live twice and dispatches a deterministic new-thread bootstrap", async () => {
    const fake = new FakeT3();
    using ledger = new ScheduleLedger(":memory:", {
      now: () => "2026-08-27T07:00:00.000Z",
    });
    const scheduler = new Scheduler(ledger, async () => fake);
    const schedule = await scheduler.put(newThreadRequest());

    const report = await scheduler.tick({ now: "2026-08-27T08:00:30.000Z", apply: true });

    expect(fake.catalogCalls).toBe(2);
    expect(report.results).toEqual([
      expect.objectContaining({ scheduleId: schedule.id, state: "verified" }),
    ]);
    expect(fake.commands[0]).toEqual(
      expect.objectContaining({
        type: "thread.turn.start",
        threadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: expect.objectContaining({
          createThread: expect.objectContaining({ projectId: "project-1", title: "Daily audit" }),
        }),
      }),
    );
  });

  test("defers a busy existing thread and later reuses the same occurrence", async () => {
    const fake = new FakeT3();
    fake.busy = true;
    using ledger = new ScheduleLedger(":memory:", {
      now: () => "2026-08-27T07:00:00.000Z",
    });
    const scheduler = new Scheduler(ledger, async () => fake);
    await scheduler.put(existingThreadRequest());

    const deferred = await scheduler.tick({ now: "2026-08-27T08:00:30.000Z", apply: true });
    fake.busy = false;
    const delivered = await scheduler.tick({ now: "2026-08-27T08:01:00.000Z", apply: true });

    expect(deferred.results[0]?.state).toBe("deferred");
    expect(delivered.results[0]?.id).toBe(deferred.results[0]?.id);
    expect(delivered.results[0]?.state).toBe("verified");
    expect(fake.commands).toHaveLength(1);
  });

  test("holds a deferred occurrence while its schedule is paused", async () => {
    const fake = new FakeT3();
    fake.busy = true;
    using ledger = new ScheduleLedger(":memory:", {
      now: () => "2026-08-27T07:00:00.000Z",
    });
    const scheduler = new Scheduler(ledger, async () => fake);
    await scheduler.put(existingThreadRequest());

    const deferred = await scheduler.tick({ now: "2026-08-27T08:00:30.000Z", apply: true });
    scheduler.pause("existing-follow-up");
    fake.busy = false;
    const paused = await scheduler.tick({ now: "2026-08-27T08:01:00.000Z", apply: true });
    await scheduler.resume("existing-follow-up");
    const resumed = await scheduler.tick({ now: "2026-08-27T08:02:00.000Z", apply: true });

    expect(deferred.results[0]?.state).toBe("deferred");
    expect(paused.results).toEqual([]);
    expect(resumed.results[0]).toEqual(
      expect.objectContaining({ id: deferred.results[0]?.id, state: "verified" }),
    );
    expect(fake.commands).toHaveLength(1);
  });

  test("verifies an unknown dispatch outcome before replaying it", async () => {
    const fake = new FakeT3();
    fake.failAfterAcceptOnce = true;
    using ledger = new ScheduleLedger(":memory:", {
      now: () => "2026-08-27T07:00:00.000Z",
    });
    const scheduler = new Scheduler(ledger, async () => fake);
    await scheduler.put(existingThreadRequest());

    const first = await scheduler.tick({ now: "2026-08-27T08:00:30.000Z", apply: true });
    const second = await scheduler.tick({ now: "2026-08-27T08:01:00.000Z", apply: true });

    expect(first.results[0]?.state).toBe("dispatching");
    expect(second.results[0]?.state).toBe("verified");
    expect(fake.commands).toHaveLength(1);
  });

  test("replays the same command ID when an unknown dispatch left no postcondition", async () => {
    const fake = new FakeT3();
    fake.failBeforeAcceptOnce = true;
    using ledger = new ScheduleLedger(":memory:", {
      now: () => "2026-08-27T07:00:00.000Z",
    });
    const scheduler = new Scheduler(ledger, async () => fake);
    await scheduler.put(existingThreadRequest());

    const first = await scheduler.tick({ now: "2026-08-27T08:00:30.000Z", apply: true });
    const second = await scheduler.tick({ now: "2026-08-27T08:01:00.000Z", apply: true });

    expect(first.results[0]?.state).toBe("dispatching");
    expect(second.results[0]?.state).toBe("verified");
    expect(fake.commands).toHaveLength(2);
    expect(fake.commands[0]?.commandId).toBe(fake.commands[1]?.commandId);
  });

  test("fails an occurrence whose deterministic T3 command was permanently rejected", async () => {
    const fake = new FakeT3();
    fake.permanentlyRejectedOnce = true;
    using ledger = new ScheduleLedger(":memory:", {
      now: () => "2026-08-27T07:00:00.000Z",
    });
    const scheduler = new Scheduler(ledger, async () => fake);
    await scheduler.put(existingThreadRequest());

    const first = await scheduler.tick({ now: "2026-08-27T08:00:30.000Z", apply: true });
    const second = await scheduler.tick({ now: "2026-08-27T08:01:00.000Z", apply: true });

    expect(first.results[0]).toEqual(expect.objectContaining({ state: "failed", attemptCount: 1 }));
    expect(second.results).toEqual([]);
    expect(fake.commands).toHaveLength(1);
  });

  test("returns a verified manual occurrence without dispatching it again", async () => {
    const fake = new FakeT3();
    using ledger = new ScheduleLedger(":memory:", {
      now: () => "2026-08-27T07:00:00.000Z",
    });
    const scheduler = new Scheduler(ledger, async () => fake);
    await scheduler.put(existingThreadRequest());

    const first = await scheduler.runNow("existing-follow-up", {
      requestId: "operator-request-1",
    });
    const second = await scheduler.runNow("existing-follow-up", {
      requestId: "operator-request-1",
    });

    if (!("id" in first) || !("id" in second)) throw new Error("Expected applied occurrences.");
    expect(first).toEqual(expect.objectContaining({ state: "verified" }));
    expect(second).toEqual(expect.objectContaining({ id: first.id, state: "verified" }));
    expect(fake.commands).toHaveLength(1);
  });

  test("dry-run plans without mutating the ledger or T3", async () => {
    const fake = new FakeT3();
    using ledger = new ScheduleLedger(":memory:", {
      now: () => "2026-08-27T07:00:00.000Z",
    });
    const scheduler = new Scheduler(ledger, async () => fake);
    await scheduler.put(newThreadRequest());

    const report = await scheduler.tick({ now: "2026-08-27T08:00:30.000Z", apply: false });

    expect(report.planned).toHaveLength(1);
    expect(ledger.listOccurrences()).toEqual([]);
    expect(fake.commands).toEqual([]);
  });

  test("rejects unsupported runtime and delivery policy values before saving", async () => {
    const fake = new FakeT3();
    using ledger = new ScheduleLedger(":memory:");
    const scheduler = new Scheduler(ledger, async () => fake);
    const request = newThreadRequest();
    const invalid = {
      ...request,
      target: { ...request.target, runtimeMode: "root" },
      policy: { misfire: "all", whenBusy: "stack" },
    } as unknown as ScheduleRequest;

    expect(scheduler.put(invalid)).rejects.toThrow("runtime mode");
    expect(ledger.listSchedules({ includeDisabled: true })).toEqual([]);
  });

  test("skip misfires advance the schedule anchor instead of retrying stale work forever", async () => {
    const fake = new FakeT3();
    using ledger = new ScheduleLedger(":memory:", {
      now: () => "2026-08-27T07:00:00.000Z",
    });
    const scheduler = new Scheduler(ledger, async () => fake);
    await scheduler.put({
      ...existingThreadRequest(),
      policy: { misfire: "skip", whenBusy: "defer" },
    });

    await scheduler.tick({ now: "2026-08-27T08:10:00.000Z", apply: true });
    const second = await scheduler.tick({ now: "2026-08-27T08:11:00.000Z", apply: true });

    expect(fake.commands).toEqual([]);
    expect(second.planned).toEqual([]);
    expect(ledger.listSchedules()[0]?.lastMaterializedAt).toBe("2026-08-27T08:11:00.000Z");
  });
});
