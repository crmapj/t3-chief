import { describe, expect, test } from "bun:test";

import type { ProviderCatalog } from "../src/adapters/t3-v1.ts";
import { FleetManager, type T3FleetPort } from "../src/core/fleet.ts";

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
          optionDescriptors: [],
        },
      ],
    },
  ],
};

function makePort(): T3FleetPort & { calls: Array<{ kind: string; value: unknown }> } {
  const calls: Array<{ kind: string; value: unknown }> = [];
  return {
    calls,
    catalog: async () => catalog,
    shell: async () => ({
      projects: [{ id: "project-1", title: "Project", workspaceRoot: "/work/project" }],
      threads: [
        {
          id: "running-1",
          projectId: "project-1",
          title: "Running",
          runtimeMode: "full-access",
          interactionMode: "default",
          modelSelection: { instanceId: "codex", model: "gpt-test" },
          latestTurn: { state: "running" },
          session: { status: "running" },
          settledOverride: null,
          archivedAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
        },
        {
          id: "review-1",
          projectId: "project-1",
          title: "Review",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          modelSelection: { instanceId: "codex", model: "gpt-test" },
          latestTurn: { state: "completed" },
          session: { status: "idle" },
          settledOverride: null,
          archivedAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
        {
          id: "blocked-1",
          projectId: "project-1",
          title: "Blocked",
          runtimeMode: "full-access",
          interactionMode: "default",
          modelSelection: { instanceId: "codex", model: "gpt-test" },
          latestTurn: { state: "completed" },
          session: { status: "idle" },
          settledOverride: null,
          archivedAt: null,
          hasPendingApprovals: true,
          hasPendingUserInput: false,
        },
        {
          id: "settled-1",
          projectId: "project-1",
          title: "Settled",
          latestTurn: { state: "completed" },
          settledOverride: "settled",
          archivedAt: null,
        },
        {
          id: "snoozed-1",
          projectId: "project-1",
          title: "Snoozed",
          latestTurn: { state: "completed" },
          session: { status: "stopped" },
          settledOverride: null,
          archivedAt: null,
          snoozedUntil: "2099-01-01T00:00:00.000Z",
        },
      ],
    }),
    thread: async (threadId, options) => {
      calls.push({ kind: "thread", value: { threadId, options } });
      return {
        thread: {
          id: threadId,
          messages: [
            {
              id: "u1",
              role: "user",
              text: "Please investigate",
              createdAt: "2026-08-27T08:00:00Z",
            },
            { id: "a1", role: "assistant", text: "Done", createdAt: "2026-08-27T08:01:00Z" },
          ],
        },
        page: { hasMore: true, beforeCursor: "older" },
      };
    },
    dispatch: async (command) => {
      calls.push({ kind: "dispatch", value: command });
      return { sequence: 1 };
    },
  };
}

describe("fleet manager", () => {
  test("classifies the active unsettled fleet from the shell only", async () => {
    const manager = new FleetManager(makePort());

    const status = await manager.status();

    expect(status.summary).toEqual({ total: 4, running: 1, review: 1, blocked: 1, snoozed: 1 });
    expect(status.threads.map((thread) => [thread.id, thread.state])).toEqual([
      ["blocked-1", "blocked-approval"],
      ["running-1", "running"],
      ["review-1", "review"],
      ["snoozed-1", "snoozed"],
    ]);
  });

  test("loads only bounded context for a requested brief", async () => {
    const port = makePort();
    const manager = new FleetManager(port);

    const brief = await manager.brief("review-1", { turnLimit: 50 });

    expect(brief.messages).toHaveLength(2);
    expect(port.calls[0]).toEqual({
      kind: "thread",
      value: { threadId: "review-1", options: { turnLimit: 50 } },
    });
  });

  test("rejects an invalid context window before calling T3", async () => {
    const port = makePort();
    const manager = new FleetManager(port);

    expect(manager.brief("review-1", { turnLimit: 0 })).rejects.toThrow("between 1 and 150");
    expect(port.calls).toEqual([]);
  });

  test("sends a follow-up with the thread's explicit modes", async () => {
    const port = makePort();
    const manager = new FleetManager(port, {
      uuid: () => "00000000-0000-4000-8000-000000000001",
      now: () => "2026-08-27T09:00:00.000Z",
    });

    await manager.send("review-1", "Continue and verify.");

    expect(port.calls.at(-1)).toEqual({
      kind: "dispatch",
      value: expect.objectContaining({
        type: "thread.turn.start",
        threadId: "review-1",
        runtimeMode: "approval-required",
        interactionMode: "plan",
        modelSelection: { instanceId: "codex", model: "gpt-test" },
        message: expect.objectContaining({ role: "user", text: "Continue and verify." }),
      }),
    });
  });

  test("settles only completed threads without pending work", async () => {
    const port = makePort();
    const manager = new FleetManager(port, { uuid: () => "00000000-0000-4000-8000-000000000001" });

    const dryRun = await manager.settleReady({ apply: false });
    const applied = await manager.settleReady({ apply: true });

    expect(dryRun.operations.map((operation) => operation.threadId)).toEqual(["review-1"]);
    expect(applied.applied).toBe(1);
    expect(port.calls.filter((call) => call.kind === "dispatch")).toHaveLength(1);
  });

  test("uses the server-required user reason when unsetting settlement", async () => {
    const port = makePort();
    const manager = new FleetManager(port, {
      uuid: () => "00000000-0000-4000-8000-000000000001",
    });

    await manager.setSettlement("review-1", false);

    expect(port.calls.at(-1)).toEqual({
      kind: "dispatch",
      value: {
        type: "thread.unsettle",
        commandId: "00000000-0000-4000-8000-000000000001",
        threadId: "review-1",
        reason: "user",
      },
    });
  });

  test("generates command IDs with the default Web Crypto provider", async () => {
    const port = makePort();
    const manager = new FleetManager(port);

    await manager.setSettlement("review-1", true);

    expect(port.calls.at(-1)).toEqual({
      kind: "dispatch",
      value: expect.objectContaining({
        type: "thread.settle",
        commandId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    });
  });

  test("starts a new thread with an explicit provider and optional managed worktree", async () => {
    const port = makePort();
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ];
    const manager = new FleetManager(port, {
      uuid: () => ids.shift() as string,
      now: () => "2026-08-27T09:00:00.000Z",
    });

    await manager.start({
      projectId: "project-1",
      title: "Fresh task",
      text: "Implement and verify it.",
      modelSelection: { instanceId: "codex", model: "gpt-test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      checkout: { kind: "managed-worktree", baseBranch: "main", startFromOrigin: true },
    });

    expect(port.calls.at(-1)).toEqual({
      kind: "dispatch",
      value: expect.objectContaining({
        type: "thread.turn.start",
        threadId: "00000000-0000-4000-8000-000000000001",
        bootstrap: expect.objectContaining({
          createThread: expect.objectContaining({ projectId: "project-1" }),
          prepareWorktree: expect.objectContaining({
            projectCwd: "/work/project",
            baseBranch: "main",
            startFromOrigin: true,
          }),
        }),
      }),
    });
  });

  test("rejects a new thread route that the live catalog does not advertise", async () => {
    const port = makePort();
    const manager = new FleetManager(port);

    expect(
      manager.start({
        projectId: "project-1",
        title: "Fresh task",
        text: "Implement and verify it.",
        modelSelection: { instanceId: "codex", model: "missing-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        checkout: { kind: "project-workspace" },
      }),
    ).rejects.toThrow("not advertised");
    expect(port.calls.filter((call) => call.kind === "dispatch")).toEqual([]);
  });

  test("lists projects with their thread counts", async () => {
    const manager = new FleetManager(makePort());

    const inventory = await manager.listProjects();

    expect(inventory.projects).toEqual([
      { id: "project-1", title: "Project", workspaceRoot: "/work/project", threadCount: 5 },
    ]);
  });

  test("registers a workspace as a project with a deterministic id", async () => {
    const port = makePort();
    const manager = new FleetManager(port, {
      uuid: () => "00000000-0000-4000-8000-000000000009",
      now: () => "2026-08-27T09:00:00.000Z",
    });

    const created = await manager.createProject({
      title: "New Project",
      workspaceRoot: "/work/new-project",
      createWorkspaceRootIfMissing: true,
    });

    expect(created.projectId).toBe("00000000-0000-4000-8000-000000000009");
    expect(port.calls.filter((call) => call.kind === "dispatch")).toEqual([
      {
        kind: "dispatch",
        value: {
          type: "project.create",
          commandId: "00000000-0000-4000-8000-000000000009",
          projectId: "00000000-0000-4000-8000-000000000009",
          title: "New Project",
          workspaceRoot: "/work/new-project",
          createWorkspaceRootIfMissing: true,
          createdAt: "2026-08-27T09:00:00.000Z",
        },
      },
    ]);
  });

  test("attaches a validated default route when one is requested", async () => {
    const port = makePort();
    const manager = new FleetManager(port, {
      uuid: () => "00000000-0000-4000-8000-000000000009",
      now: () => "2026-08-27T09:00:00.000Z",
    });

    await manager.createProject({
      title: "Routed",
      workspaceRoot: "/work/routed",
      defaultModelSelection: { instanceId: "codex", model: "gpt-test", options: [] },
    });

    const dispatched = port.calls.find((call) => call.kind === "dispatch")?.value as Record<
      string,
      unknown
    >;
    expect(dispatched.defaultModelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-test",
      options: [],
    });
  });

  test("refuses a duplicate workspace, a relative root, and an unadvertised default route", async () => {
    const port = makePort();
    const manager = new FleetManager(port);

    expect(
      manager.createProject({ title: "Duplicate", workspaceRoot: "/work/project/" }),
    ).rejects.toThrow("already belongs to project 'project-1'");
    expect(manager.createProject({ title: "Relative", workspaceRoot: "work" })).rejects.toThrow(
      "absolute path",
    );
    expect(
      manager.createProject({ title: "Blank", workspaceRoot: "/work/x" }),
    ).resolves.toBeDefined();
    expect(
      manager.createProject({
        title: "Bad route",
        workspaceRoot: "/work/bad",
        defaultModelSelection: { instanceId: "nope", model: "gpt-test", options: [] },
      }),
    ).rejects.toThrow("not advertised");
  });
});

const TRIAGE_NOW = "2030-03-01T12:00:00.000Z";

/** Minutes before `TRIAGE_NOW`, so every fixture timestamp reads as an age. */
function minutesAgo(minutes: number): string {
  return new Date(Date.parse(TRIAGE_NOW) - minutes * 60_000).toISOString();
}

function triageThread(
  id: string,
  projectId: string,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    projectId,
    title: id,
    runtimeMode: "full-access",
    interactionMode: "default",
    modelSelection: { instanceId: "codex", model: "gpt-test" },
    session: { status: "idle" },
    settledOverride: null,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

function makeTriagePort(): T3FleetPort {
  return {
    catalog: async () => catalog,
    shell: async () => ({
      projects: [
        { id: "project-1", title: "Alpha", workspaceRoot: "/work/alpha" },
        { id: "project-2", title: "Beta", workspaceRoot: "/work/beta" },
      ],
      threads: [
        triageThread("alpha-fresh", "project-1", {
          latestTurn: { state: "completed" },
          updatedAt: minutesAgo(30),
        }),
        triageThread("alpha-boundary", "project-1", {
          latestTurn: { state: "completed" },
          updatedAt: minutesAgo(1_440),
        }),
        triageThread("alpha-stale", "project-1", {
          latestTurn: { state: "failed" },
          updatedAt: minutesAgo(4_320),
        }),
        triageThread("alpha-undated", "project-1", { latestTurn: { state: "completed" } }),
        triageThread("beta-blocked", "project-2", {
          latestTurn: { state: "completed" },
          hasPendingApprovals: true,
          updatedAt: minutesAgo(2_880),
        }),
        triageThread("beta-settled", "project-2", {
          latestTurn: { state: "completed" },
          settledOverride: "settled",
          updatedAt: minutesAgo(10_080),
        }),
      ],
    }),
    thread: async (threadId) => ({ thread: { id: threadId, messages: [] } }),
    dispatch: async () => ({ sequence: 1 }),
  };
}

function triageManager(): FleetManager {
  return new FleetManager(makeTriagePort(), { now: () => TRIAGE_NOW });
}

describe("fleet status filters", () => {
  test("returns every unsettled thread when no filter is given", async () => {
    const status = await triageManager().status();

    expect(status.threads.map((thread) => thread.id)).toEqual([
      "beta-blocked",
      "alpha-stale",
      "alpha-boundary",
      "alpha-fresh",
      "alpha-undated",
    ]);
    expect(status.summary).toEqual({ total: 5, blocked: 1, failed: 1, review: 3 });
  });

  test("restricts the fleet to one project by title or id prefix", async () => {
    const byTitle = await triageManager().status({ project: "Beta" });
    const byPrefix = await triageManager().status({ project: "project-1" });

    expect(byTitle.threads.map((thread) => thread.id)).toEqual(["beta-blocked"]);
    expect(byTitle.summary).toEqual({ total: 1, blocked: 1 });
    expect(byPrefix.threads.every((thread) => thread.projectId === "project-1")).toBe(true);
  });

  test("rejects a project reference the fleet does not have", async () => {
    expect(triageManager().status({ project: "Gamma" })).rejects.toThrow("was not found");
  });

  test("restricts the fleet to named states and expands the blocked alias", async () => {
    const failed = await triageManager().status({ states: ["failed"] });
    const blocked = await triageManager().status({ states: ["blocked"] });
    const either = await triageManager().status({ states: ["failed", "blocked"] });

    expect(failed.threads.map((thread) => thread.id)).toEqual(["alpha-stale"]);
    expect(blocked.threads.map((thread) => thread.id)).toEqual(["beta-blocked"]);
    expect(either.threads.map((thread) => thread.id)).toEqual(["beta-blocked", "alpha-stale"]);
    expect(either.summary).toEqual({ total: 2, blocked: 1, failed: 1 });
  });

  test("rejects a state the classifier never produces", async () => {
    expect(triageManager().status({ states: ["done"] })).rejects.toThrow("Unknown thread state");
  });

  test("treats a thread updated exactly one bound ago as stale, and a newer one as fresh", async () => {
    const day = await triageManager().status({ staleForMilliseconds: 24 * 60 * 60_000 });
    const justOver = await triageManager().status({
      staleForMilliseconds: 24 * 60 * 60_000 + 60_000,
    });

    expect(day.threads.map((thread) => thread.id)).toEqual([
      "beta-blocked",
      "alpha-stale",
      "alpha-boundary",
    ]);
    expect(justOver.threads.map((thread) => thread.id)).toEqual(["beta-blocked", "alpha-stale"]);
  });

  test("never reports an undated thread as stale", async () => {
    const stale = await triageManager().status({ staleForMilliseconds: 60_000 });

    expect(stale.threads.map((thread) => thread.id)).not.toContain("alpha-undated");
  });

  test("orders by oldest update first and sorts undated threads last", async () => {
    const byAge = await triageManager().status({ order: "age" });

    expect(byAge.threads.map((thread) => thread.id)).toEqual([
      "alpha-stale",
      "beta-blocked",
      "alpha-boundary",
      "alpha-fresh",
      "alpha-undated",
    ]);
  });

  test("combines every filter and summarizes only what it returns", async () => {
    const combined = await triageManager().status({
      project: "Alpha",
      states: ["failed", "review"],
      staleForMilliseconds: 12 * 60 * 60_000,
      order: "age",
    });

    expect(combined.threads.map((thread) => thread.id)).toEqual(["alpha-stale", "alpha-boundary"]);
    expect(combined.summary).toEqual({ total: 2, failed: 1, review: 1 });
  });
});

/**
 * A self-driven thread: one user message followed by a long run of assistant messages. The whole
 * transcript sits inside a single user-anchored turn, which is why the turn window cannot bound it.
 */
function makeSelfDrivenPort(): T3FleetPort & { requested: Array<Record<string, unknown>> } {
  const requested: Array<Record<string, unknown>> = [];
  const messages = [
    { id: "u1", role: "user", text: "Supervise the fleet.", createdAt: minutesAgo(600) },
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `a${index + 1}`,
      role: "assistant",
      text: `step ${index + 1}`,
      createdAt: minutesAgo(400 - index * 10),
    })),
  ];
  return {
    requested,
    catalog: async () => catalog,
    shell: async () => ({
      projects: [{ id: "project-1", title: "Alpha", workspaceRoot: "/work/alpha" }],
      threads: [triageThread("supervisor", "project-1", { latestTurn: { state: "completed" } })],
    }),
    thread: async (threadId, options) => {
      requested.push({ threadId, ...options });
      return { thread: { id: threadId, messages }, page: { hasMore: true } };
    },
    dispatch: async () => ({ sequence: 1 }),
  };
}

function selfDrivenManager(port: T3FleetPort): FleetManager {
  return new FleetManager(port, { now: () => TRIAGE_NOW });
}

describe("fleet brief bounds", () => {
  test("returns the whole turn window and no bounds report when no bound is asked for", async () => {
    const port = makeSelfDrivenPort();

    const brief = await selfDrivenManager(port).brief("supervisor", { turnLimit: 3 });

    expect(brief.messages).toHaveLength(41);
    expect(brief.bounds).toBeUndefined();
    expect(port.requested).toEqual([{ threadId: "supervisor", turnLimit: 3 }]);
  });

  test("caps the projection at the newest messages whatever the turn window returns", async () => {
    const port = makeSelfDrivenPort();

    const brief = await selfDrivenManager(port).brief("supervisor", {
      turnLimit: 3,
      maxMessages: 6,
    });

    expect(brief.messages.map((message) => message.id)).toEqual([
      "a35",
      "a36",
      "a37",
      "a38",
      "a39",
      "a40",
    ]);
    expect(brief.bounds).toEqual({
      turnLimit: 3,
      maxMessages: 6,
      since: null,
      available: 41,
      returned: 6,
      dropped: 35,
    });
  });

  test("keeps messages at or newer than the recency cutoff and reports the cutoff used", async () => {
    const port = makeSelfDrivenPort();

    const brief = await selfDrivenManager(port).brief("supervisor", {
      turnLimit: 50,
      sinceMilliseconds: 60 * 60_000,
    });

    expect(brief.messages.map((message) => message.id)).toEqual([
      "a35",
      "a36",
      "a37",
      "a38",
      "a39",
      "a40",
    ]);
    expect(brief.bounds).toEqual({
      turnLimit: 50,
      maxMessages: null,
      since: "2030-03-01T11:00:00.000Z",
      available: 41,
      returned: 6,
      dropped: 35,
    });
  });

  test("applies the message cap to what survives the recency bound", async () => {
    const port = makeSelfDrivenPort();

    const brief = await selfDrivenManager(port).brief("supervisor", {
      turnLimit: 50,
      sinceMilliseconds: 60 * 60_000,
      maxMessages: 2,
    });

    expect(brief.messages.map((message) => message.id)).toEqual(["a39", "a40"]);
    expect(brief.bounds).toMatchObject({ maxMessages: 2, available: 41, returned: 2, dropped: 39 });
  });

  test("keeps the whole window when the cap is larger than the window", async () => {
    const port = makeSelfDrivenPort();

    const brief = await selfDrivenManager(port).brief("supervisor", {
      turnLimit: 3,
      maxMessages: 500,
    });

    expect(brief.bounds).toMatchObject({ available: 41, returned: 41, dropped: 0 });
  });

  test("never counts an undated message as inside the recency bound", async () => {
    const port = makeSelfDrivenPort();
    const undated = { id: "a41", role: "assistant", text: "no timestamp" };
    const original = port.thread;
    port.thread = async (threadId, options) => {
      const detail = (await original(threadId, options)) as {
        thread: { messages: Array<Record<string, unknown>> };
      };
      return { thread: { ...detail.thread, messages: [...detail.thread.messages, undated] } };
    };

    const brief = await selfDrivenManager(port).brief("supervisor", {
      sinceMilliseconds: 60 * 60_000,
    });

    expect(brief.messages.map((message) => message.id)).not.toContain("a41");
  });

  test("spends the character budget on the messages the cap kept", async () => {
    const port = makeSelfDrivenPort();

    const brief = await selfDrivenManager(port).brief("supervisor", {
      maxMessages: 2,
      maxTotalCharacters: 9,
    });

    expect(brief.messages.map((message) => message.text)).toEqual(["st", "step 40"]);
    expect(brief.bounds).toMatchObject({ returned: 2, dropped: 39 });
  });

  test("rejects a message cap outside its range before calling T3", async () => {
    const port = makeSelfDrivenPort();
    const manager = selfDrivenManager(port);

    expect(manager.brief("supervisor", { maxMessages: 0 })).rejects.toThrow("between 1 and 1000");
    expect(manager.brief("supervisor", { maxMessages: 1_001 })).rejects.toThrow(
      "between 1 and 1000",
    );
    expect(manager.brief("supervisor", { maxMessages: 2.5 })).rejects.toThrow("between 1 and 1000");
    expect(port.requested).toEqual([]);
  });
});
