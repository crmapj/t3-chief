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
