import { describe, expect, test } from "bun:test";

import { type ClaudeQuotaCache, ClaudeQuotaSource } from "../src/adapters/claude-quota.ts";
import type { CommandRunner } from "../src/config.ts";

const NOW = new Date("2030-01-01T18:40:00.000Z");
const PROFILES = [{ name: "work", tokenCommand: ["/opt/token", "work"] }];

const HEADERS = {
  "anthropic-ratelimit-unified-5h-utilization": "0.2",
  "anthropic-ratelimit-unified-5h-reset": "1893517200",
  "anthropic-ratelimit-unified-7d-utilization": "0.6",
  "anthropic-ratelimit-unified-7d-reset": "1894104000",
  "anthropic-ratelimit-unified-status": "allowed_warning",
};

class FakeCache implements ClaudeQuotaCache {
  readonly entries = new Map<string, { payload: unknown; expiresAt: string }>();
  readonly endpoints = new Map<string, string>();
  readonly backOffs: Array<{ endpoint: string; nextAllowedAt: string; status: string }> = [];

  readProviderLimit(cacheKey: string, now: string): unknown | null {
    const entry = this.entries.get(cacheKey);
    return entry && entry.expiresAt > now ? entry.payload : null;
  }
  writeProviderLimit(cacheKey: string, payload: unknown, _observedAt: string, expiresAt: string) {
    this.entries.set(cacheKey, { payload, expiresAt });
  }
  reserveProviderEndpoint(endpoint: string, now: string, nextAllowedAt: string): boolean {
    const current = this.endpoints.get(endpoint);
    if (current && current > now) return false;
    this.endpoints.set(endpoint, nextAllowedAt);
    return true;
  }
  backOffProviderEndpoint(endpoint: string, nextAllowedAt: string, status: string) {
    this.endpoints.set(endpoint, nextAllowedAt);
    this.backOffs.push({ endpoint, nextAllowedAt, status });
  }
}

function runner(token = "CLAUDE_TOKEN_SENTINEL_SECRET"): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === "claude") return { exitCode: 0, stdout: "2.1.234 (Claude Code)\n", stderr: "" };
    return { exitCode: 0, stdout: `${token}\n`, stderr: "" };
  }) as CommandRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

function response(
  status: number,
  init: { headers?: Record<string, string>; body?: unknown } = {},
): Response {
  return new Response(init.body === undefined ? null : JSON.stringify(init.body), {
    status,
    headers: init.headers ?? {},
  });
}

function source(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  overrides: Partial<ConstructorParameters<typeof ClaudeQuotaSource>[0]> = {},
) {
  const cache = overrides.cache ?? new FakeCache();
  const runCommand = overrides.runCommand ?? runner();
  return {
    cache: cache as FakeCache,
    runCommand,
    quota: new ClaudeQuotaSource({
      profiles: PROFILES,
      cache,
      runCommand,
      fetcher: (input, init) => fetcher(String(input), init),
      now: () => NOW,
      ...overrides,
    }),
  };
}

describe("claude quota source", () => {
  test("falls back to inference headers when the usage endpoint refuses the token scope", async () => {
    const seen: Array<{ url: string; userAgent: string | null }> = [];
    const { quota } = source(async (url, init) => {
      seen.push({
        url,
        userAgent: new Headers(init?.headers as HeadersInit).get("user-agent"),
      });
      if (url.endsWith("/api/oauth/usage")) {
        return response(403, { body: { error: { message: "scope requirement user:profile" } } });
      }
      return response(200, { headers: HEADERS, body: { id: "msg" } });
    });

    const [row] = await quota.read();

    expect(row?.source).toBe("probe");
    expect(row?.profile).toBe("work");
    expect(row?.windows).toEqual([
      { label: "5h", usedPercent: 20, resetsAt: "2030-01-01T17:00:00.000Z" },
      { label: "weekly", usedPercent: 60, resetsAt: "2030-01-08T12:00:00.000Z" },
    ]);
    expect(row?.notes?.some((note) => note.includes("allowed_warning"))).toBe(true);
    expect(seen.map((call) => call.url)).toEqual([
      "https://api.anthropic.com/api/oauth/usage",
      "https://api.anthropic.com/v1/messages",
    ]);
    // Without a client user agent the usage endpoint throttles hard and stickily.
    expect(seen.every((call) => call.userAgent === "claude-code/2.1.234")).toBe(true);
  });

  test("prefers the zero-cost usage endpoint and normalizes its 0..100 percentages", async () => {
    let messages = 0;
    const { quota } = source(async (url) => {
      if (url.endsWith("/v1/messages")) {
        messages += 1;
        return response(200, { headers: HEADERS });
      }
      return response(200, {
        body: {
          five_hour: { utilization: 20, resets_at: "2030-01-01T17:00:00.000Z" },
          seven_day: { utilization: 60, resets_at: "2030-01-08T12:00:00.000Z" },
        },
      });
    });

    const [row] = await quota.read();

    expect(row?.source).toBe("oauth-usage");
    expect(row?.windows).toEqual([
      { label: "5h", usedPercent: 20, resetsAt: "2030-01-01T17:00:00.000Z" },
      { label: "weekly", usedPercent: 60, resetsAt: "2030-01-08T12:00:00.000Z" },
    ]);
    expect(messages).toBe(0);
  });

  test("serves a cached reading without spending a token or a request", async () => {
    let requests = 0;
    const cache = new FakeCache();
    const first = source(
      async (url) => {
        requests += 1;
        if (url.endsWith("/api/oauth/usage")) return response(403);
        return response(200, { headers: HEADERS });
      },
      { cache },
    );

    await first.quota.read();
    const before = requests;
    const second = source(
      async () => {
        requests += 1;
        return response(200, { headers: HEADERS });
      },
      { cache },
    );
    const [row] = await second.quota.read();

    expect(requests).toBe(before);
    expect(row?.source).toBe("probe");
  });

  test("honours Retry-After on 429 and refuses to probe again while cooling down", async () => {
    const cache = new FakeCache();
    const { quota } = source(async () => response(429, { headers: { "retry-after": "600" } }), {
      cache,
    });

    const [limited] = await quota.read();

    expect(limited?.source).toBe("unknown");
    expect(cache.backOffs[0]?.status).toBe("usage-429");
    expect(cache.backOffs[0]?.nextAllowedAt).toBe("2030-01-01T18:50:00.000Z");

    const second = source(async () => response(200, { headers: HEADERS }), { cache });
    const [cooling] = await second.quota.read();

    expect(cooling?.source).toBe("unknown");
    expect(cooling?.notes?.[0]).toContain("cooling down");
  });

  test("a second process cannot probe inside the minimum interval", async () => {
    const cache = new FakeCache();
    const answer = async () => response(200, { headers: HEADERS });
    await source(answer, { cache }).quota.read();
    cache.entries.clear();

    const [row] = await source(answer, { cache }).quota.read();

    expect(row?.source).toBe("unknown");
    expect(row?.notes?.[0]).toContain("cooling down");
  });

  test("uses a fresh statusline capture instead of spending a probe", async () => {
    let requests = 0;
    const { quota } = source(
      async () => {
        requests += 1;
        return response(200, { headers: HEADERS });
      },
      {
        statusline: {
          read: () => ({
            reading: {
              windows: [{ label: "5h", usedPercent: 30, resetsAt: null }],
              status: "allowed",
            },
            capturedAt: "2030-01-01T18:38:00.000Z",
          }),
        },
      },
    );

    const [row] = await quota.read();

    expect(row?.source).toBe("statusline");
    expect(row?.windows[0]?.usedPercent).toBe(30);
    expect(requests).toBe(0);
  });

  test("--no-probe reports unreadable rather than calling the endpoints", async () => {
    let requests = 0;
    const { quota } = source(
      async () => {
        requests += 1;
        return response(200, { headers: HEADERS });
      },
      { allowInference: false },
    );

    const [row] = await quota.read();

    expect(requests).toBe(0);
    expect(row?.source).toBe("unknown");
    expect(row?.notes?.[0]).toContain("--no-probe");
  });

  test("never leaks a failing token command's stderr", async () => {
    const failing = (async () => ({
      exitCode: 3,
      stdout: "",
      stderr: "CLAUDE_STDERR_SENTINEL_SECRET",
    })) as CommandRunner;
    const { quota } = source(async () => response(200, { headers: HEADERS }), {
      runCommand: failing,
    });

    const [row] = await quota.read();

    expect(row?.source).toBe("unknown");
    expect(JSON.stringify(row)).not.toContain("CLAUDE_STDERR_SENTINEL_SECRET");
    expect(row?.notes?.[0]).toContain("exited 3");
  });
});
