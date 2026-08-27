import { describe, expect, test } from "bun:test";

import {
  budgetPercent,
  claudeUserAgent,
  newerCodexSnapshot,
  parseClaudeUsageLines,
  parseCodexAppServerLimits,
  parseCodexRateLimitLine,
  parseGrokQuota,
  parseOAuthUsage,
  parseStatuslinePayload,
  parseUnifiedRateLimitHeaders,
  retryAfterSeconds,
  summarizeClaudeUsage,
  windowLabel,
} from "../src/domain/limits.ts";

const codexLine = JSON.stringify({
  timestamp: "2030-01-01T18:37:55.147Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { total_token_usage: { total_tokens: 12 } },
    rate_limits: {
      limit_id: "codex_example",
      limit_name: "Example Plan",
      primary: { used_percent: 20, window_minutes: 300, resets_at: 1_893_538_800 },
      secondary: { used_percent: 40, window_minutes: 10_080, resets_at: 1_894_125_600 },
      credits: { has_credits: false, unlimited: false, balance: "0" },
    },
  },
});

function claudeLine(input: { id: string; at: string; output: number; model?: string }): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: input.at,
    requestId: `req_${input.id}`,
    uuid: `${input.id}-${input.at}`,
    message: {
      id: input.id,
      model: input.model ?? "claude-opus-5",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 1_000,
        output_tokens: input.output,
      },
    },
  });
}

describe("limits domain", () => {
  test("labels rate-limit windows from their length in minutes", () => {
    expect(windowLabel(300)).toBe("5h");
    expect(windowLabel(10_080)).toBe("weekly");
    expect(windowLabel(1_440)).toBe("daily");
    expect(windowLabel(45)).toBe("45m");
    expect(windowLabel(0)).toBe("unknown");
  });

  test("parses both windows and credits from a Codex rate_limits event", () => {
    const snapshot = parseCodexRateLimitLine(codexLine);

    expect(snapshot).toEqual({
      observedAt: "2030-01-01T18:37:55.147Z",
      limitName: "Example Plan",
      limitId: "codex_example",
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      windows: [
        { label: "5h", usedPercent: 20, resetsAt: "2030-01-01T23:00:00.000Z" },
        { label: "weekly", usedPercent: 40, resetsAt: "2030-01-08T18:00:00.000Z" },
      ],
    });
  });

  test("ignores rollout lines without a usable rate_limits payload", () => {
    expect(parseCodexRateLimitLine("")).toBeNull();
    expect(parseCodexRateLimitLine("{not json")).toBeNull();
    expect(
      parseCodexRateLimitLine(
        JSON.stringify({ timestamp: "2030-01-01T18:00:00Z", payload: { type: "token_count" } }),
      ),
    ).toBeNull();
    expect(
      parseCodexRateLimitLine(
        JSON.stringify({ payload: { rate_limits: { credits: { balance: "0" } } } }),
      ),
    ).toBeNull();
  });

  test("keeps the newest dated snapshot", () => {
    const older = parseCodexRateLimitLine(codexLine);
    const newer = { ...(older as NonNullable<typeof older>), observedAt: "2030-01-01T19:00:00Z" };
    const undated = { ...(older as NonNullable<typeof older>), observedAt: "" };

    expect(newerCodexSnapshot(older, newer)).toBe(newer);
    expect(newerCodexSnapshot(newer, older)).toBe(newer);
    expect(newerCodexSnapshot(newer, undated)).toBe(newer);
    expect(newerCodexSnapshot(null, undated)).toBe(undated);
  });

  test("keeps only Claude usage rows inside the window", () => {
    const rows = parseClaudeUsageLines(
      [
        claudeLine({ id: "msg_1", at: "2030-01-01T10:00:00.000Z", output: 10 }),
        claudeLine({ id: "msg_2", at: "2030-01-01T18:00:00.000Z", output: 20 }),
        "",
        '{"message":{"usage":',
      ],
      { profile: "work", since: "2030-01-01T14:00:00.000Z", until: "2030-01-01T19:00:00.000Z" },
    );

    expect(rows.map((row) => row.key)).toEqual(["work:msg_2"]);
  });

  test("de-duplicates the repeated streaming records of one API response", () => {
    const rows = parseClaudeUsageLines(
      [
        claudeLine({ id: "msg_1", at: "2030-01-01T18:00:00.000Z", output: 20 }),
        claudeLine({ id: "msg_1", at: "2030-01-01T18:00:01.000Z", output: 20 }),
        claudeLine({ id: "msg_1", at: "2030-01-01T18:00:02.000Z", output: 20 }),
        claudeLine({ id: "msg_2", at: "2030-01-01T18:05:00.000Z", output: 5, model: "claude-x" }),
      ],
      { profile: "work", since: "2030-01-01T14:00:00.000Z", until: "2030-01-01T19:00:00.000Z" },
    );
    const summary = summarizeClaudeUsage(rows, "2030-01-01T14:00:00.000Z");

    expect(summary.requests).toBe(2);
    expect(summary.outputTokens).toBe(25);
    expect(summary.cacheReadInputTokens).toBe(2_000);
    expect(summary.totalTokens).toBe(2 * 2 + 200 + 2_000 + 25);
    expect(summary.models).toEqual(["claude-opus-5", "claude-x"]);
    expect(summary.profiles).toEqual(["work"]);
  });

  test("separates identical message IDs seen in different profiles", () => {
    const at = "2030-01-01T18:00:00.000Z";
    const window = { since: "2030-01-01T14:00:00.000Z", until: "2030-01-01T19:00:00.000Z" };
    const rows = [
      ...parseClaudeUsageLines([claudeLine({ id: "msg_1", at, output: 3 })], {
        profile: "work",
        ...window,
      }),
      ...parseClaudeUsageLines([claudeLine({ id: "msg_1", at, output: 3 })], {
        profile: "personal",
        ...window,
      }),
    ];

    expect(summarizeClaudeUsage(rows, window.since).requests).toBe(2);
  });

  test("normalizes unified rate-limit headers from fractions and epoch seconds", () => {
    const headers = new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.2",
      "anthropic-ratelimit-unified-5h-reset": "1893517200",
      "anthropic-ratelimit-unified-7d-utilization": "0.6",
      "anthropic-ratelimit-unified-7d-reset": "1894104000",
      "anthropic-ratelimit-unified-status": "allowed_warning",
    });

    expect(parseUnifiedRateLimitHeaders(headers)).toEqual({
      status: "allowed_warning",
      windows: [
        { label: "5h", usedPercent: 20, resetsAt: "2030-01-01T17:00:00.000Z" },
        { label: "weekly", usedPercent: 60, resetsAt: "2030-01-08T12:00:00.000Z" },
      ],
    });
    expect(parseUnifiedRateLimitHeaders(new Headers({}))).toBeNull();
  });

  test("reads the usage endpoint's 0..100 percentages and ISO resets", () => {
    expect(
      parseOAuthUsage({
        five_hour: { utilization: 20, resets_at: "2030-01-01T17:00:00.000Z" },
        seven_day: { utilization: 60, resets_at: null },
      }),
    ).toEqual({
      status: null,
      windows: [
        { label: "5h", usedPercent: 20, resetsAt: "2030-01-01T17:00:00.000Z" },
        { label: "weekly", usedPercent: 60, resetsAt: null },
      ],
    });
    expect(parseOAuthUsage({ five_hour: null, seven_day: {} })).toBeNull();
    expect(parseOAuthUsage(null)).toBeNull();
  });

  test("reads a Claude Code statusline payload and tolerates one without rate limits", () => {
    expect(
      parseStatuslinePayload({
        rate_limits: {
          five_hour: { used_percentage: 40, resets_at: 1_893_517_200 },
          seven_day: { used_percentage: 60, resets_at: 1_894_104_000 },
        },
      }),
    ).toEqual({
      status: null,
      windows: [
        { label: "5h", usedPercent: 40, resetsAt: "2030-01-01T17:00:00.000Z" },
        { label: "weekly", usedPercent: 60, resetsAt: "2030-01-08T12:00:00.000Z" },
      ],
    });
    expect(parseStatuslinePayload({ model: { id: "claude-opus-5" } })).toBeNull();
  });

  test("reads Retry-After as seconds or as an HTTP date", () => {
    const now = new Date("2030-01-01T18:40:00.000Z");

    expect(retryAfterSeconds("600", now)).toBe(600);
    expect(retryAfterSeconds("Tue, 1 Jan 2030 18:45:00 GMT", now)).toBe(300);
    expect(retryAfterSeconds("Tue, 1 Jan 2030 18:00:00 GMT", now)).toBe(0);
    expect(retryAfterSeconds(null, now)).toBeNull();
    expect(retryAfterSeconds("soon", now)).toBeNull();
  });

  test("builds the client user agent from the installed Claude Code version", () => {
    expect(claudeUserAgent("2.1.234 (Claude Code)\n")).toBe("claude-code/2.1.234");
    expect(claudeUserAgent("not a version")).toBe("claude-code");
  });

  test("maps every Codex bucket, and skips buckets with no window", () => {
    const buckets = parseCodexAppServerLimits({
      rateLimitsByLimitId: {
        "example-burst": {
          limitId: "example-burst",
          limitName: "Example burst allowance",
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_893_517_200 },
          secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_894_104_000 },
          planType: "example-plan",
        },
        "example-weekly": {
          limitId: "example-weekly",
          primary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1_894_104_000 },
          credits: { hasCredits: false, unlimited: false, balance: "0" },
        },
        empty: { limitId: "empty", primary: null, secondary: null },
      },
    });

    expect(buckets.map((bucket) => bucket.limitId)).toEqual(["example-burst", "example-weekly"]);
    expect(buckets[0]?.windows).toEqual([
      { label: "5h", usedPercent: 0, resetsAt: "2030-01-01T17:00:00.000Z" },
      { label: "weekly", usedPercent: 40, resetsAt: "2030-01-08T12:00:00.000Z" },
    ]);
    expect(buckets[1]?.windows.map((window) => window.label)).toEqual(["weekly"]);
    expect(buckets[0]?.limitName).toBe("Example burst allowance");
    expect(parseCodexAppServerLimits({})).toEqual([]);
    expect(parseCodexAppServerLimits(null)).toEqual([]);
  });

  test("reports a Grok seat honestly when no headroom metric is published", () => {
    const quota = parseGrokQuota(
      {
        subscription_tier: "Example plan",
        config: {
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            end: "2030-01-08T12:00:00.000000+00:00",
          },
          onDemandCap: { val: 0 },
          onDemandUsed: { val: 0 },
        },
      },
      { authenticated: true, meta: { email: "person@example.com", gate: null } },
    );

    expect(quota?.windows).toEqual([
      { label: "weekly", usedPercent: null, resetsAt: "2030-01-08T12:00:00.000Z" },
    ]);
    expect(quota?.blocked).toBe(false);
    expect(JSON.stringify(quota)).not.toContain("example.com");
    expect(parseGrokQuota(null, null)).toBeNull();
  });

  test("flags a gated or unauthenticated Grok seat", () => {
    const quota = parseGrokQuota(
      { subscription_tier: "Example plan" },
      { authenticated: false, meta: { gate: "payment_required" } },
    );

    expect(quota?.blocked).toBe(true);
    expect(quota?.notes).toContain("Account is not authenticated.");
    expect(quota?.notes).toContain("Access gate active: payment_required.");
  });

  test("reports a percentage only against a calibrated budget", () => {
    expect(budgetPercent(800, 4_000)).toBe(20);
    expect(budgetPercent(1_000, 10_000)).toBe(10);
    expect(budgetPercent(1_000, null)).toBeNull();
    expect(budgetPercent(1_000, 0)).toBeNull();
  });
});
