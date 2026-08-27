import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostJob, JobAction } from "../src/adapters/host-jobs.ts";
import { ScheduleLedger } from "../src/adapters/ledger.ts";
import type { ProviderCatalog } from "../src/adapters/t3-v1.ts";
import { type CliDependencies, runCli } from "../src/cli.ts";
import { ConfigStore } from "../src/config.ts";
import type {
  ClaudeTranscriptFile,
  LimitsFile,
  LimitsSource,
  LimitsTail,
  ProviderProbe,
} from "../src/core/limits.ts";
import type { SchedulerT3Port } from "../src/core/scheduler.ts";

const catalog: ProviderCatalog = {
  observedAt: "2030-01-01T07:00:00.000Z",
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

const t3: SchedulerT3Port = {
  catalog: async () => catalog,
  shell: async () => ({
    projects: [{ id: "project-1", title: "Project", workspaceRoot: "/work/project" }],
    threads: [
      {
        id: "thread-1",
        projectId: "project-1",
        title: "Existing",
        modelSelection: { instanceId: "codex", model: "gpt-test" },
        runtimeMode: "full-access",
        interactionMode: "default",
        latestTurn: { state: "completed" },
        session: { status: "idle" },
        settledOverride: null,
        archivedAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      },
    ],
  }),
  thread: async (threadId) => ({ thread: { id: threadId, messages: [] } }),
  dispatch: async () => ({ sequence: 1 }),
};

class FakeHostJobs {
  async list(): Promise<{ jobs: HostJob[]; warnings: string[] }> {
    return {
      jobs: [
        {
          ref: "systemd:user:t3-nightly-update.timer",
          source: "user-systemd",
          id: "t3-nightly-update.timer",
          label: "Update T3 nightly",
          enabled: true,
          capabilities: ["enable", "disable", "run"],
          tags: ["t3", "nightly-update"],
        },
        {
          ref: "cron:user:example",
          source: "user-cron",
          id: "example",
          label: "curl -H 'Authorization: Bearer JOB_SENTINEL_SECRET' https://example.invalid",
          command: "curl -H 'Authorization: Bearer JOB_SENTINEL_SECRET' https://example.invalid",
          sourcePath: "user-crontab",
          schedule: "0 1 * * *",
          enabled: true,
          capabilities: ["enable", "disable", "run"],
          tags: [],
        },
      ],
      warnings: [],
    };
  }
  async manage(
    _ref: string,
    _action: JobAction,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

const codexSnapshotLine = JSON.stringify({
  timestamp: "2030-01-01T18:38:00.000Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    rate_limits: {
      limit_name: "Example Plan",
      primary: { used_percent: 20, window_minutes: 300, resets_at: 1_893_538_800 },
      secondary: { used_percent: 40, window_minutes: 10_080, resets_at: 1_894_125_600 },
      credits: { has_credits: false, unlimited: false, balance: "0" },
    },
  },
});

class FakeLimitsSource implements LimitsSource {
  async codexRollouts(): Promise<LimitsFile[]> {
    return [{ path: "/rollouts/new.jsonl", modifiedAt: "2030-01-01T18:39:00.000Z" }];
  }
  async claudeTranscripts(): Promise<ClaudeTranscriptFile[]> {
    return [];
  }
  async readTail(): Promise<LimitsTail> {
    return { text: codexSnapshotLine, truncated: false };
  }
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** No-op probe. Tests that care inject their own; the rest must never touch a real provider. */
const noProbe: ProviderProbe = { read: async () => [] };

/**
 * Every CLI test gets its own config and state directory, and stubbed provider probes. Without
 * that, `limits` would read the developer's own configuration, spawn the real `codex` and `grok`
 * CLIs, and reach the network during `bun test`.
 */
function harness(ledger: ScheduleLedger) {
  let stdout = "";
  let stderr = "";
  const directory = mkdtempSync(join(tmpdir(), "t3chief-cli-"));
  temporaryDirectories.push(directory);
  const dependencies: CliDependencies = {
    configStore: new ConfigStore({ configDirectory: directory, stateDirectory: directory }),
    ledger,
    resolveEnvironment: async () => t3,
    hostJobs: new FakeHostJobs(),
    limitsSource: new FakeLimitsSource(),
    codexProbe: noProbe,
    grokProbe: noProbe,
    writeOut: (value: string) => {
      stdout += value;
    },
    writeErr: (value: string) => {
      stderr += value;
    },
  };
  return { dependencies, directory, stdout: () => stdout, stderr: () => stderr };
}

describe("CLI", () => {
  for (const [label, argv] of [
    ["missing arguments", ["--json", "brief"]],
    ["unknown commands", ["--json", "not-a-command"]],
    ["unknown options", ["--json", "--not-an-option"]],
  ] as const) {
    test(`emits exactly one JSON error for ${label}`, async () => {
      using ledger = new ScheduleLedger(":memory:");
      const io = harness(ledger);

      const code = await runCli([...argv], io.dependencies);
      const lines = io.stderr().trim().split("\n");

      expect(code).not.toBe(0);
      expect(io.stdout()).toBe("");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] as string)).toEqual(
        expect.objectContaining({
          version: 1,
          ok: false,
          error: expect.objectContaining({ code: "COMMAND_FAILED" }),
        }),
      );
    });
  }

  test("prints the version once without an error footer", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);

    const code = await runCli(["--version"], io.dependencies);

    expect(code).toBe(0);
    expect(io.stdout()).toBe("0.6.1\n");
    expect(io.stderr()).toBe("");
  });

  test("emits a stable JSON envelope for the live provider catalog", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);

    const code = await runCli(["providers", "--json"], io.dependencies);
    const result = JSON.parse(io.stdout());

    expect(code).toBe(0);
    expect(result).toEqual(
      expect.objectContaining({
        version: 1,
        ok: true,
        command: "providers",
        data: expect.objectContaining({
          providers: [expect.objectContaining({ instanceId: "codex" })],
        }),
      }),
    );
  });

  test("reports provider headroom with its source for every known provider", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);

    const code = await runCli(["--json", "limits"], io.dependencies);
    const result = JSON.parse(io.stdout());

    expect(code).toBe(0);
    expect(result.command).toBe("limits");
    expect(
      result.data.providers.map((provider: { provider: string; source: string }) => [
        provider.provider,
        provider.source,
      ]),
    ).toEqual([
      ["codex", "exact-snapshot"],
      ["claude", "estimate"],
      ["grok", "unknown"],
    ]);
    expect(result.data.providers[0].windows).toEqual([
      { label: "5h", usedPercent: 20, resetsAt: "2030-01-01T23:00:00.000Z" },
      { label: "weekly", usedPercent: 40, resetsAt: "2030-01-08T18:00:00.000Z" },
    ]);
  });

  test("prints limits as scannable text and honours --provider", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);

    const code = await runCli(["limits", "--provider", "codex"], io.dependencies);

    expect(code).toBe(0);
    expect(io.stdout()).toContain("codex                      source=exact-snapshot");
    expect(io.stdout()).toContain("5h          20% used  resets=2030-01-01T23:00:00.000Z");
    expect(io.stdout()).not.toContain("grok");
  });

  test("rejects an unknown limits provider without touching artifacts", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);

    const code = await runCli(["--json", "limits", "--provider", "gemini"], io.dependencies);

    expect(code).toBe(1);
    expect(JSON.parse(io.stderr()).error.message).toContain("Unknown provider(s) gemini");
  });

  test("creates a project and returns its id in the JSON envelope", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);
    let dispatched: Record<string, unknown> = {};
    io.dependencies.resolveEnvironment = async () => ({
      ...t3,
      dispatch: async (command: Record<string, unknown>) => {
        dispatched = command;
        return { sequence: 1 };
      },
    });

    const code = await runCli(
      [
        "--json",
        "project",
        "create",
        "--title",
        "Fleet Tooling",
        "--workspace",
        "/work/fleet-tooling",
        "--create-workspace",
      ],
      io.dependencies,
    );
    const result = JSON.parse(io.stdout());

    expect(code).toBe(0);
    expect(result.command).toBe("project.create");
    expect(result.data.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(dispatched.type).toBe("project.create");
    expect(dispatched.projectId).toBe(result.data.projectId);
    expect(dispatched.workspaceRoot).toBe("/work/fleet-tooling");
    expect(dispatched.createWorkspaceRootIfMissing).toBe(true);
  });

  test("lists projects with thread counts", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);

    const code = await runCli(["--json", "project", "list"], io.dependencies);

    expect(code).toBe(0);
    expect(JSON.parse(io.stdout()).data.projects).toEqual([
      { id: "project-1", title: "Project", workspaceRoot: "/work/project", threadCount: 1 },
    ]);
  });

  test("refuses a half-specified project default route", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);

    const code = await runCli(
      [
        "--json",
        "project",
        "create",
        "--title",
        "T",
        "--workspace",
        "/work/t",
        "--provider",
        "codex",
      ],
      io.dependencies,
    );

    expect(code).toBe(1);
    expect(JSON.parse(io.stderr()).error.message).toContain("both --provider and --model");
  });

  test("prefers a Claude probe reading over the transcript estimate", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);
    io.dependencies.claudeProbe = {
      read: async () => [
        {
          provider: "claude",
          profile: "work",
          windows: [
            { label: "5h", usedPercent: 20, resetsAt: "2030-01-01T17:00:00.000Z" },
            { label: "weekly", usedPercent: 60, resetsAt: "2030-01-08T12:00:00.000Z" },
          ],
          source: "probe",
          observedAt: "2030-01-01T18:40:00.000Z",
        },
      ],
    };

    const code = await runCli(["--json", "limits", "--provider", "claude"], io.dependencies);
    const providers = JSON.parse(io.stdout()).data.providers;

    expect(code).toBe(0);
    expect(providers).toHaveLength(1);
    expect(providers[0].source).toBe("probe");
    expect(providers[0].profile).toBe("work");
    expect(providers[0].usage).toBeUndefined();
  });

  test("keeps the transcript estimate when every configured profile fails", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);
    io.dependencies.claudeProbe = {
      read: async () => [
        {
          provider: "claude",
          profile: "work",
          windows: [],
          source: "unknown",
          observedAt: null,
          notes: ["Endpoint is cooling down; another probe ran recently."],
        },
      ],
    };

    const code = await runCli(["--json", "limits", "--provider", "claude"], io.dependencies);
    const providers = JSON.parse(io.stdout()).data.providers;

    expect(code).toBe(0);
    expect(providers.map((row: { source: string }) => row.source)).toEqual(["unknown", "estimate"]);
  });

  test("configures and forgets a Claude token command without storing a token", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);

    await runCli(
      [
        "--json",
        "limits",
        "configure-claude",
        "--profile",
        "work",
        "--command",
        "/opt/token",
        "work",
      ],
      io.dependencies,
    );

    expect(JSON.parse(io.stdout()).data.profiles).toEqual([
      { name: "work", tokenCommand: ["/opt/token", "work"] },
    ]);
    const saved = await readFile(join(io.directory, "config.json"), "utf8");
    expect(saved).toContain("/opt/token");

    await runCli(["--json", "limits", "configure-claude", "--remove", "work"], io.dependencies);

    const lines = io.stdout().trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1] as string).data.profiles).toEqual([]);
  });

  test("captures statusline quota from stdin and stays silent", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);
    io.dependencies.readStdin = async () =>
      JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 40, resets_at: 1_893_517_200 },
          seven_day: { used_percentage: 60, resets_at: 1_894_104_000 },
        },
      });

    const code = await runCli(["limits", "statusline-sink", "--profile", "work"], io.dependencies);

    expect(code).toBe(0);
    expect(io.stdout()).toBe("");
    const captured = JSON.parse(
      await readFile(join(io.directory, "statusline", "work.json"), "utf8"),
    );
    expect(captured.reading.windows[0]).toEqual({
      label: "5h",
      usedPercent: 40,
      resetsAt: "2030-01-01T17:00:00.000Z",
    });
  });

  test("warns before opting a remote environment into plaintext transport", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);
    io.dependencies.readStdin = async () => "scoped-token";
    let allowInsecure = false;
    io.dependencies.createT3Client = (options) => {
      expect(io.stderr()).toContain("warning: --insecure");
      allowInsecure = options.allowInsecure === true;
      return {
        descriptor: async () => ({ environmentId: "env-example", label: "Example" }),
        shell: async () => ({ projects: [], threads: [] }),
      };
    };

    const code = await runCli(
      [
        "environment",
        "add",
        "example",
        "--url",
        "http://t3.example",
        "--token-stdin",
        "--insecure",
        "--json",
      ],
      io.dependencies,
    );

    expect(code).toBe(0);
    expect(allowInsecure).toBe(true);
    expect(io.stderr()).toContain("warning: --insecure");
    expect((await io.dependencies.configStore?.load())?.environments.example?.insecure).toBe(true);
  });

  test("thread send --reply-to appends the deterministic reply footer", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);
    let sentText = "";
    io.dependencies.resolveEnvironment = async () => ({
      ...t3,
      dispatch: async (command: Record<string, unknown>) => {
        sentText = (command as { message?: { text?: string } }).message?.text ?? "";
        return { sequence: 1 };
      },
    });

    const code = await runCli(
      [
        "thread",
        "send",
        "thread-1",
        "--prompt",
        "Ship the fix.",
        "--reply-to",
        "chief-9",
        "--json",
      ],
      io.dependencies,
    );

    expect(code).toBe(0);
    expect(sentText.startsWith("Ship the fix.")).toBe(true);
    expect(sentText).toContain("REPLY-TO THREAD: chief-9");
    expect(sentText).toContain("t3chief thread send chief-9 --prompt");
  });

  test("thread send without --reply-to leaves the prompt untouched", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);
    let sentText = "";
    io.dependencies.resolveEnvironment = async () => ({
      ...t3,
      dispatch: async (command: Record<string, unknown>) => {
        sentText = (command as { message?: { text?: string } }).message?.text ?? "";
        return { sequence: 1 };
      },
    });

    const code = await runCli(
      ["thread", "send", "thread-1", "--prompt", "Ship the fix.", "--json"],
      io.dependencies,
    );

    expect(code).toBe(0);
    expect(sentText).toBe("Ship the fix.");
  });

  test("creates and lists a scheduled new thread from common-case flags", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);

    const code = await runCli(
      [
        "schedule",
        "add",
        "daily-audit",
        "--cron",
        "0 8 * * *",
        "--timezone",
        "UTC",
        "--project",
        "project-1",
        "--new-thread",
        "Daily audit",
        "--provider",
        "codex",
        "--model",
        "gpt-test",
        "--effort",
        "high",
        "--runtime-mode",
        "full-access",
        "--prompt",
        "Audit and report.",
        "--json",
      ],
      io.dependencies,
    );

    expect(code).toBe(0);
    expect(ledger.listSchedules({ includeDisabled: true })[0]).toEqual(
      expect.objectContaining({ key: "daily-audit", revision: 1 }),
    );
  });

  test("persists a cron until bound and auto-disables the schedule once it passes", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);

    const added = await runCli(
      [
        "schedule",
        "add",
        "bounded-burst",
        "--cron",
        "*/20 * * * *",
        "--timezone",
        "UTC",
        "--until",
        "2020-06-01T00:00:00.000Z",
        "--thread",
        "thread-1",
        "--prompt",
        "Check in.",
        "--json",
      ],
      io.dependencies,
    );

    expect(added).toBe(0);
    const stored = ledger.listSchedules({ includeDisabled: true })[0];
    expect(stored?.trigger).toEqual({
      kind: "cron",
      expression: "*/20 * * * *",
      timeZone: "UTC",
      until: "2020-06-01T00:00:00.000Z",
    });
    expect(stored?.enabled).toBe(true);

    const ticked = await runCli(
      ["schedule", "tick", "--apply", "--now", "2030-01-01T00:00:00.000Z", "--json"],
      io.dependencies,
    );

    expect(ticked).toBe(0);
    expect(ledger.listSchedules({ includeDisabled: true })[0]?.enabled).toBe(false);
  });

  test("unifies t3-chief schedules and host jobs", async () => {
    using ledger = new ScheduleLedger(":memory:");
    ledger.putSchedule({
      managerId: "chief",
      key: "existing-follow-up",
      environment: "home",
      trigger: { kind: "once", at: "2030-01-02T08:00:00.000Z" },
      target: { kind: "existing-thread", threadId: "thread-1" },
      prompt: "Follow up.",
      enabled: true,
      policy: { misfire: "latest", whenBusy: "defer" },
    });
    const io = harness(ledger);

    const code = await runCli(["jobs", "--json"], io.dependencies);
    const result = JSON.parse(io.stdout());

    expect(code).toBe(0);
    expect(result.data.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "t3:existing-follow-up", source: "t3chief" }),
        expect.objectContaining({ ref: "systemd:user:t3-nightly-update.timer" }),
      ]),
    );
    expect(io.stdout()).not.toContain("JOB_SENTINEL_SECRET");
    expect(result.data.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "cron:user:example", label: "Cron command (redacted)" }),
      ]),
    );
    expect(
      result.data.jobs.find((entry: { ref: string }) => entry.ref === "cron:user:example"),
    ).not.toHaveProperty("command");
  });

  test("includes cron commands only with the explicit local opt-in", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);

    const code = await runCli(["jobs", "--include-commands", "--json"], io.dependencies);

    expect(code).toBe(0);
    expect(io.stdout()).toContain("JOB_SENTINEL_SECRET");
  });

  test("redacts stored schedule prompts unless explicitly requested", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const added = harness(ledger);
    await runCli(
      [
        "schedule",
        "add",
        "private-prompt",
        "--at",
        "2030-01-02T08:00:00.000Z",
        "--thread",
        "thread-1",
        "--prompt",
        "PROMPT_SENTINEL_SECRET",
        "--json",
      ],
      added.dependencies,
    );

    expect(ledger.listSchedules({ includeDisabled: true })[0]?.prompt).toBe(
      "PROMPT_SENTINEL_SECRET",
    );
    expect(added.stdout()).not.toContain("PROMPT_SENTINEL_SECRET");

    const hidden = harness(ledger);
    await runCli(["schedule", "show", "private-prompt", "--json"], hidden.dependencies);
    expect(hidden.stdout()).not.toContain("PROMPT_SENTINEL_SECRET");

    const included = harness(ledger);
    await runCli(
      ["schedule", "show", "private-prompt", "--include-prompt", "--json"],
      included.dependencies,
    );
    expect(included.stdout()).toContain("PROMPT_SENTINEL_SECRET");
  });

  test("runs the one-minute supervisor tick across all three recovery loops", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const io = harness(ledger);

    const code = await runCli(
      ["tick", "--apply", "--now", "2030-01-01T09:00:00.000Z", "--json"],
      io.dependencies,
    );
    const result = JSON.parse(io.stdout());

    expect(code).toBe(0);
    expect(result.data).toEqual(
      expect.objectContaining({
        ok: true,
        schedules: expect.objectContaining({ apply: true }),
        rateLimits: expect.objectContaining({ apply: true }),
        maintenance: expect.objectContaining({ windowId: null }),
      }),
    );
  });

  test("captures and closes a maintenance window through public commands", async () => {
    using ledger = new ScheduleLedger(":memory:");
    const captured = harness(ledger);

    expect(await runCli(["maintenance", "capture", "--json"], captured.dependencies)).toBe(0);
    const windowId = JSON.parse(captured.stdout()).data.windowId;

    const stopped = harness(ledger);
    expect(
      await runCli(
        ["maintenance", "stopped", "--at", "2030-01-01T09:00:01.000Z", "--json"],
        stopped.dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(stopped.stdout()).data).toEqual(
      expect.objectContaining({ id: windowId, status: "stopped" }),
    );
  });
});
