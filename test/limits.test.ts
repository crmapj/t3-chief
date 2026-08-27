import { describe, expect, test } from "bun:test";

import {
  type ClaudeTranscriptFile,
  type LimitsFile,
  LimitsReporter,
  type LimitsSource,
  type LimitsTail,
} from "../src/core/limits.ts";

const NOW = "2030-01-01T18:40:00.000Z";

function rateLimitLine(input: { at: string; primary: number; secondary: number }): string {
  return JSON.stringify({
    timestamp: input.at,
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        limit_id: "codex_example",
        limit_name: "Example Plan",
        primary: { used_percent: input.primary, window_minutes: 300, resets_at: 1_893_538_800 },
        secondary: {
          used_percent: input.secondary,
          window_minutes: 10_080,
          resets_at: 1_894_125_600,
        },
        credits: { has_credits: true, unlimited: false, balance: "12.50" },
      },
    },
  });
}

function usageLine(input: { id: string; at: string; output: number }): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: input.at,
    message: {
      id: input.id,
      model: "claude-opus-5",
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 100,
        output_tokens: input.output,
      },
    },
  });
}

class FakeLimitsSource implements LimitsSource {
  readonly reads: string[] = [];
  readonly truncated = new Set<string>();

  constructor(
    private readonly rollouts: LimitsFile[] = [],
    private readonly transcripts: ClaudeTranscriptFile[] = [],
    private readonly contents: Record<string, string> = {},
  ) {}

  async codexRollouts(): Promise<LimitsFile[]> {
    return this.rollouts;
  }

  async claudeTranscripts(): Promise<ClaudeTranscriptFile[]> {
    return this.transcripts;
  }

  async readTail(path: string): Promise<LimitsTail> {
    this.reads.push(path);
    const content = this.contents[path];
    if (content === undefined) throw new Error(`missing fixture ${path}`);
    return { text: content, truncated: this.truncated.has(path) };
  }
}

function reporter(source: LimitsSource, options: { budget?: number | null } = {}) {
  return new LimitsReporter({
    source,
    now: () => new Date(NOW),
    ...(options.budget === undefined ? {} : { claudeTokenBudget: options.budget }),
  });
}

describe("provider limits", () => {
  test("reports the newest exact Codex snapshot with both windows and credits", async () => {
    const source = new FakeLimitsSource(
      [
        { path: "/rollouts/new.jsonl", modifiedAt: "2030-01-01T18:39:00.000Z" },
        { path: "/rollouts/old.jsonl", modifiedAt: "2029-12-31T09:00:00.000Z" },
      ],
      [],
      {
        "/rollouts/new.jsonl": [
          rateLimitLine({ at: "2030-01-01T17:00:00.000Z", primary: 10, secondary: 20 }),
          '{"type":"event_msg","payload":{"type":"agent_message"}}',
          rateLimitLine({ at: "2030-01-01T18:38:00.000Z", primary: 20, secondary: 40 }),
        ].join("\n"),
        "/rollouts/old.jsonl": rateLimitLine({
          at: "2029-12-31T09:00:00.000Z",
          primary: 90,
          secondary: 60,
        }),
      },
    );

    const report = await reporter(source).report({ providers: ["codex"] });
    const codex = report.providers[0];

    expect(report.at).toBe(NOW);
    expect(codex?.source).toBe("exact-snapshot");
    expect(codex?.observedAt).toBe("2030-01-01T18:38:00.000Z");
    expect(codex?.windows).toEqual([
      { label: "5h", usedPercent: 20, resetsAt: "2030-01-01T23:00:00.000Z" },
      { label: "weekly", usedPercent: 40, resetsAt: "2030-01-08T18:00:00.000Z" },
    ]);
    expect(codex?.credits).toEqual({ hasCredits: true, unlimited: false, balance: "12.50" });
    expect(source.reads).toEqual(["/rollouts/new.jsonl", "/rollouts/old.jsonl"]);
  });

  test("falls back to an older rollout when the newest tail carries no snapshot", async () => {
    const source = new FakeLimitsSource(
      [
        { path: "/rollouts/new.jsonl", modifiedAt: "2030-01-01T18:39:00.000Z" },
        { path: "/rollouts/old.jsonl", modifiedAt: "2029-12-31T09:00:00.000Z" },
      ],
      [],
      {
        "/rollouts/new.jsonl": '{"type":"event_msg","payload":{"type":"agent_message"}}',
        "/rollouts/old.jsonl": rateLimitLine({
          at: "2029-12-31T09:00:00.000Z",
          primary: 90,
          secondary: 60,
        }),
      },
    );

    const report = await reporter(source).report({ providers: ["codex"] });

    expect(report.providers[0]?.source).toBe("exact-snapshot");
    expect(report.providers[0]?.observedAt).toBe("2029-12-31T09:00:00.000Z");
  });

  test("prefers the all-bucket Codex probe over the single-bucket rollout", async () => {
    const source = new FakeLimitsSource(
      [{ path: "/rollouts/new.jsonl", modifiedAt: "2030-01-01T18:39:00.000Z" }],
      [],
      {
        "/rollouts/new.jsonl": rateLimitLine({
          at: "2030-01-01T18:38:00.000Z",
          primary: 0,
          secondary: 0,
        }),
      },
    );
    const probing = new LimitsReporter({
      source,
      now: () => new Date(NOW),
      probes: {
        codex: {
          read: async ({ at }) => [
            {
              provider: "codex",
              profile: "example-weekly",
              windows: [{ label: "weekly", usedPercent: 20, resetsAt: null }],
              source: "probe",
              observedAt: at,
            },
          ],
        },
      },
    });

    const report = await probing.report({ providers: ["codex"] });

    expect(report.providers).toHaveLength(1);
    expect(report.providers[0]?.source).toBe("probe");
    expect(report.providers[0]?.windows[0]?.usedPercent).toBe(20);
    expect(source.reads).toEqual([]);
  });

  test("falls back to the rollout and says which bucket and how old it is", async () => {
    const source = new FakeLimitsSource(
      [{ path: "/rollouts/new.jsonl", modifiedAt: "2030-01-01T18:39:00.000Z" }],
      [],
      {
        "/rollouts/new.jsonl": rateLimitLine({
          at: "2030-01-01T18:10:00.000Z",
          primary: 0,
          secondary: 0,
        }),
      },
    );
    const probing = new LimitsReporter({
      source,
      now: () => new Date(NOW),
      probes: {
        codex: {
          read: async () => [
            {
              provider: "codex",
              windows: [],
              source: "unknown",
              observedAt: null,
              notes: ["App server unavailable."],
            },
          ],
        },
      },
    });

    const report = await probing.report({ providers: ["codex"] });
    const rollout = report.providers[1];

    expect(report.providers[0]?.source).toBe("unknown");
    expect(rollout?.source).toBe("exact-snapshot");
    expect(rollout?.profile).toBe("codex_example");
    expect(rollout?.notes?.[0]).toContain("Single-bucket reading");
    expect(rollout?.notes?.[1]).toContain("30 minute(s) ago");
  });

  test("says unknown rather than zero when no Codex artifact exists", async () => {
    const report = await reporter(new FakeLimitsSource()).report({ providers: ["codex"] });

    expect(report.providers[0]).toEqual({
      provider: "codex",
      windows: [],
      source: "unknown",
      observedAt: null,
      notes: ["No Codex rollout files were found on this host."],
    });
  });

  test("estimates Claude usage from transcripts touched inside the window", async () => {
    const source = new FakeLimitsSource(
      [],
      [
        { path: "/p/live.jsonl", modifiedAt: "2030-01-01T18:30:00.000Z", profile: "work" },
        { path: "/s/live.jsonl", modifiedAt: "2030-01-01T18:20:00.000Z", profile: "personal" },
        { path: "/p/cold.jsonl", modifiedAt: "2029-12-25T10:00:00.000Z", profile: "work" },
      ],
      {
        "/p/live.jsonl": [
          usageLine({ id: "msg_1", at: "2030-01-01T18:00:00.000Z", output: 40 }),
          usageLine({ id: "msg_1", at: "2030-01-01T18:00:01.000Z", output: 40 }),
          usageLine({ id: "msg_old", at: "2030-01-01T09:00:00.000Z", output: 999 }),
        ].join("\n"),
        "/s/live.jsonl": usageLine({ id: "msg_1", at: "2030-01-01T18:10:00.000Z", output: 60 }),
      },
    );

    const report = await reporter(source).report({ providers: ["claude"] });
    const claude = report.providers[0];

    expect(source.reads).toEqual(["/p/live.jsonl", "/s/live.jsonl"]);
    expect(claude?.source).toBe("estimate");
    expect(claude?.usage?.requests).toBe(2);
    expect(claude?.usage?.outputTokens).toBe(100);
    expect(claude?.usage?.profiles).toEqual(["personal", "work"]);
    expect(claude?.usage?.windowStartedAt).toBe("2030-01-01T13:40:00.000Z");
    expect(claude?.windows).toEqual([{ label: "5h", usedPercent: null, resetsAt: null }]);
    expect(claude?.notes?.some((note) => note.includes("--claude-budget"))).toBe(true);
  });

  test("turns the Claude estimate into a percentage once a budget is supplied", async () => {
    const source = new FakeLimitsSource(
      [],
      [{ path: "/p/live.jsonl", modifiedAt: "2030-01-01T18:30:00.000Z", profile: "work" }],
      { "/p/live.jsonl": usageLine({ id: "msg_1", at: "2030-01-01T18:00:00.000Z", output: 889 }) },
    );

    const report = await reporter(source, { budget: 10_000 }).report({ providers: ["claude"] });

    expect(report.providers[0]?.usage?.totalTokens).toBe(1_000);
    expect(report.providers[0]?.windows[0]?.usedPercent).toBe(10);
    expect(report.providers[0]?.notes?.some((note) => note.includes("--claude-budget"))).toBe(
      false,
    );
  });

  test("warns that a truncated transcript makes the estimate a floor", async () => {
    const source = new FakeLimitsSource(
      [],
      [{ path: "/p/live.jsonl", modifiedAt: "2030-01-01T18:30:00.000Z", profile: "work" }],
      { "/p/live.jsonl": usageLine({ id: "msg_1", at: "2030-01-01T18:00:00.000Z", output: 1 }) },
    );
    source.truncated.add("/p/live.jsonl");

    const report = await reporter(source).report({ providers: ["claude"] });

    expect(report.providers[0]?.notes?.some((note) => note.includes("floor"))).toBe(true);
  });

  test("prefers an authenticated probe over the transcript estimate", async () => {
    const source = new FakeLimitsSource();
    const probing = new LimitsReporter({
      source,
      now: () => new Date(NOW),
      probes: {
        claude: {
          read: async ({ at }) => [
            {
              provider: "claude",
              profile: "work",
              windows: [{ label: "5h", usedPercent: 60, resetsAt: "2030-01-01T17:00:00.000Z" }],
              source: "oauth-usage",
              observedAt: at,
            },
          ],
        },
      },
    });

    const report = await probing.report({ providers: ["claude"] });

    expect(report.providers[0]?.source).toBe("oauth-usage");
    expect(report.providers[0]?.windows[0]?.usedPercent).toBe(60);
    expect(source.reads).toEqual([]);
  });

  test("reports Grok as unknown and rejects providers it cannot read", async () => {
    const source = new FakeLimitsSource();

    const report = await reporter(source).report();

    expect(report.providers.map((provider) => provider.provider)).toEqual([
      "codex",
      "claude",
      "grok",
    ]);
    const grok = report.providers[2];
    expect(grok?.source).toBe("unknown");
    expect(grok?.windows).toEqual([]);
    expect(grok?.notes?.[0]).toContain("unknown, not zero");
    expect(reporter(source).report({ providers: ["gemini"] })).rejects.toThrow(
      /Unknown provider\(s\) gemini/,
    );
  });
});
