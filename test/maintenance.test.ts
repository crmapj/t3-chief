import { describe, expect, test } from "bun:test";

import { ScheduleLedger } from "../src/adapters/ledger.ts";
import type { ProviderCatalog } from "../src/adapters/t3-v1.ts";
import {
  MaintenanceManager,
  type MaintenanceT3Port,
  RateLimitManager,
} from "../src/core/maintenance.ts";

const catalog: ProviderCatalog = {
  observedAt: "2026-08-27T07:00:00.000Z",
  fingerprint: "a".repeat(64),
  providers: [],
};

type ThreadShape = {
  id: string;
  projectId: string;
  title: string;
  runtimeMode: string;
  interactionMode: string;
  modelSelection: { instanceId: string; model: string };
  latestTurn: {
    turnId: string;
    state: string;
    requestedAt?: string;
    completedAt?: string;
  };
  session: { status: string };
  settledOverride: null | string;
  archivedAt: null | string;
  deletedAt: null | string;
  latestUserMessageAt: string;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
};

class FakeT3 implements MaintenanceT3Port {
  readonly calls: Array<{ kind: string; value: unknown }> = [];
  threads: ThreadShape[] = [];
  messages = new Map<string, Array<Record<string, unknown>>>();
  onDispatch?: (command: Record<string, unknown>) => void;

  async catalog(): Promise<ProviderCatalog> {
    return catalog;
  }

  async shell(): Promise<unknown> {
    this.calls.push({ kind: "shell", value: null });
    return { projects: [], threads: structuredClone(this.threads) };
  }

  async thread(threadId: string, options?: { turnLimit?: number }): Promise<unknown> {
    this.calls.push({ kind: "thread", value: { threadId, options } });
    const thread = this.threads.find((item) => item.id === threadId);
    if (!thread) throw new Error("HTTP 404 not found");
    return {
      thread: {
        ...structuredClone(thread),
        messages: structuredClone(this.messages.get(threadId) ?? []),
      },
    };
  }

  async dispatch(command: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ kind: "dispatch", value: command });
    this.onDispatch?.(command);
    return { sequence: 1 };
  }
}

function thread(overrides: Partial<ThreadShape> = {}): ThreadShape {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Agent task",
    runtimeMode: "full-access",
    interactionMode: "default",
    modelSelection: { instanceId: "codex", model: "gpt-test" },
    latestTurn: { turnId: "turn-1", state: "completed" },
    session: { status: "idle" },
    settledOverride: null,
    archivedAt: null,
    deletedAt: null,
    latestUserMessageAt: "2026-08-27T18:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

const limitMessage = {
  id: "assistant:limit-1",
  role: "assistant",
  text: "You've hit your session limit · resets 8:30pm (UTC)",
  createdAt: "2026-08-27T18:35:00.000Z",
};

describe("rate-limit recovery", () => {
  test("observes before reset, dispatches once when due, and verifies replay", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const t3 = new FakeT3();
    t3.threads = [thread()];
    t3.messages.set("thread-1", [limitMessage]);
    const manager = new RateLimitManager(ledger, async () => t3);

    const observed = await manager.tick({
      environment: "home",
      now: "2026-08-27T19:00:00.000Z",
      apply: true,
    });
    expect(observed.watching).toEqual(["thread-1"]);
    expect(t3.calls.filter((call) => call.kind === "dispatch")).toHaveLength(0);
    expect(t3.calls.find((call) => call.kind === "thread")?.value).toEqual({
      threadId: "thread-1",
      options: { turnLimit: 1 },
    });

    t3.onDispatch = (command) => {
      const message = command.message as Record<string, unknown>;
      t3.messages.set("thread-1", [
        limitMessage,
        {
          id: message.messageId,
          role: "user",
          text: message.text,
          createdAt: command.createdAt,
        },
      ]);
    };
    const due = await manager.tick({
      environment: "home",
      now: "2026-08-27T20:32:00.000Z",
      apply: true,
    });
    const replay = await manager.tick({
      environment: "home",
      now: "2026-08-27T20:33:00.000Z",
      apply: true,
    });

    expect(due.woke).toEqual(["thread-1"]);
    expect(replay.woke).toEqual([]);
    expect(t3.calls.filter((call) => call.kind === "dispatch")).toHaveLength(1);
    expect(ledger.listRateLimitSignals({ environment: "home" })[0]?.status).toBe("woke");
  });

  test("never resurrects a limit first observed after its due instant", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const t3 = new FakeT3();
    t3.threads = [thread()];
    t3.messages.set("thread-1", [limitMessage]);
    const manager = new RateLimitManager(ledger, async () => t3);

    const result = await manager.tick({
      environment: "home",
      now: "2026-08-27T21:00:00.000Z",
      apply: true,
    });

    expect(result.ignoredLate).toEqual(["thread-1"]);
    expect(t3.calls.filter((call) => call.kind === "dispatch")).toHaveLength(0);
  });

  test("a dry run loads bounded detail but writes no observation", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const t3 = new FakeT3();
    t3.threads = [thread()];
    t3.messages.set("thread-1", [limitMessage]);
    const manager = new RateLimitManager(ledger, async () => t3);

    await manager.tick({
      environment: "home",
      now: "2026-08-27T19:00:00.000Z",
      apply: false,
    });

    expect(ledger.listRateLimitSignals({ environment: "home" })).toEqual([]);
  });

  test("settling a limited thread cancels its pending recovery", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const t3 = new FakeT3();
    t3.threads = [thread()];
    t3.messages.set("thread-1", [limitMessage]);
    const manager = new RateLimitManager(ledger, async () => t3);

    await manager.tick({
      environment: "home",
      now: "2026-08-27T19:00:00.000Z",
      apply: true,
    });
    t3.threads = [thread({ settledOverride: "settled" })];
    const result = await manager.tick({
      environment: "home",
      now: "2026-08-27T19:30:00.000Z",
      apply: true,
    });

    expect(result.superseded).toEqual(["thread-1"]);
    expect(ledger.listRateLimitSignals({ environment: "home" })[0]?.status).toBe("superseded");
  });
});

describe("maintenance recovery", () => {
  test("capture and stop markers are idempotent within one maintenance window", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const t3 = new FakeT3();
    t3.threads = [
      thread({
        latestTurn: { turnId: "turn-1", state: "running" },
        session: { status: "running" },
      }),
    ];
    let now = "2026-08-27T06:00:00.000Z";
    const manager = new MaintenanceManager(ledger, async () => t3, { now: () => now });

    const first = await manager.capture("home");
    now = "2026-08-27T06:00:01.000Z";
    const replay = await manager.capture("home");
    const stopped = manager.markStopped("home", "2026-08-27T06:00:02.000Z");
    const stopReplay = manager.markStopped("home", "2026-08-27T06:00:03.000Z");

    expect(replay.windowId).toBe(first.windowId);
    expect(replay.reused).toBe(true);
    expect(stopped.id).toBe(stopReplay.id);
  });

  test("captures an active turn and resumes it once after a maintenance interruption", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const t3 = new FakeT3();
    t3.threads = [
      thread({
        latestTurn: {
          turnId: "turn-1",
          state: "running",
          requestedAt: "2026-08-27T05:55:00.000Z",
        },
        session: { status: "running" },
      }),
    ];
    const manager = new MaintenanceManager(ledger, async () => t3, {
      now: () => "2026-08-27T06:00:00.000Z",
    });

    const captured = await manager.capture("home");
    expect(captured.captured).toBe(1);
    manager.markStopped("home", "2026-08-27T06:00:02.000Z");

    t3.threads = [
      thread({
        latestTurn: {
          turnId: "turn-1",
          state: "interrupted",
          requestedAt: "2026-08-27T05:55:00.000Z",
          completedAt: "2026-08-27T06:00:01.000Z",
        },
      }),
    ];
    t3.onDispatch = (command) => {
      const message = command.message as Record<string, unknown>;
      t3.messages.set("thread-1", [
        {
          id: message.messageId,
          role: "user",
          text: message.text,
          createdAt: command.createdAt,
        },
      ]);
    };

    const delivered = await manager.deliver("home", "2026-08-27T06:01:00.000Z");
    const replay = await manager.deliver("home", "2026-08-27T06:02:00.000Z");

    expect(delivered.delivered).toEqual(["thread-1"]);
    expect(replay.delivered).toEqual([]);
    expect(t3.calls.filter((call) => call.kind === "dispatch")).toHaveLength(1);
    expect(ledger.listMaintenanceWindows({ environment: "home" })[0]?.status).toBe("complete");
  });

  test("discovers a turn started in the capture-to-stop race window", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const t3 = new FakeT3();
    t3.threads = [];
    const manager = new MaintenanceManager(ledger, async () => t3, {
      now: () => "2026-08-27T06:00:00.000Z",
    });

    await manager.capture("home");
    manager.markStopped("home", "2026-08-27T06:00:04.000Z");
    t3.threads = [
      thread({
        id: "race-thread",
        latestTurn: {
          turnId: "race-turn",
          state: "interrupted",
          requestedAt: "2026-08-27T06:00:02.000Z",
          completedAt: "2026-08-27T06:00:03.000Z",
        },
      }),
    ];

    const result = await manager.deliver("home", "2026-08-27T06:01:00.000Z");

    expect(result.discoveredInStopWindow).toEqual(["race-thread"]);
    expect(t3.calls.filter((call) => call.kind === "dispatch")).toHaveLength(1);
  });

  test("replaces a captured turn when the same thread starts another turn before stop", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const t3 = new FakeT3();
    t3.threads = [
      thread({
        latestTurn: {
          turnId: "turn-before-capture",
          state: "running",
          requestedAt: "2026-08-27T05:59:00.000Z",
        },
        session: { status: "running" },
      }),
    ];
    const manager = new MaintenanceManager(ledger, async () => t3, {
      now: () => "2026-08-27T06:00:00.000Z",
    });

    const captured = await manager.capture("home");
    manager.markStopped("home", "2026-08-27T06:00:04.000Z");
    t3.threads = [
      thread({
        latestTurn: {
          turnId: "turn-in-stop-window",
          state: "interrupted",
          requestedAt: "2026-08-27T06:00:02.000Z",
          completedAt: "2026-08-27T06:00:03.000Z",
        },
      }),
    ];

    const result = await manager.deliver("home", "2026-08-27T06:01:00.000Z");
    const saved = ledger.listMaintenanceTurns(captured.windowId);

    expect(result.discoveredInStopWindow).toEqual(["thread-1"]);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.turnId).toBe("turn-in-stop-window");
    expect(t3.calls.filter((call) => call.kind === "dispatch")).toHaveLength(1);
  });

  test("does not resume a turn that completed normally before shutdown", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const t3 = new FakeT3();
    t3.threads = [
      thread({
        latestTurn: { turnId: "turn-1", state: "running" },
        session: { status: "running" },
      }),
    ];
    const manager = new MaintenanceManager(ledger, async () => t3, {
      now: () => "2026-08-27T06:00:00.000Z",
    });

    await manager.capture("home");
    manager.markStopped("home", "2026-08-27T06:00:02.000Z");
    t3.threads = [thread({ latestTurn: { turnId: "turn-1", state: "completed" } })];

    const result = await manager.deliver("home", "2026-08-27T06:01:00.000Z");

    expect(result.superseded).toEqual(["thread-1"]);
    expect(t3.calls.filter((call) => call.kind === "dispatch")).toHaveLength(0);
  });
});
