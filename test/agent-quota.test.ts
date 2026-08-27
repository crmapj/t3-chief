import { describe, expect, test } from "bun:test";

import type { RpcExchange, RpcReply, StdioRpc } from "../src/adapters/agent-rpc.ts";
import { SpawnFailedError } from "../src/adapters/agent-rpc.ts";
import type { ClaudeQuotaCache } from "../src/adapters/claude-quota.ts";
import { CodexQuotaSource } from "../src/adapters/codex-quota.ts";
import { GrokQuotaSource } from "../src/adapters/grok-quota.ts";

const NOW = new Date("2030-01-01T20:42:00.000Z");

class FakeCache implements ClaudeQuotaCache {
  readonly entries = new Map<string, { payload: unknown; expiresAt: string }>();
  readonly endpoints = new Map<string, string>();

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
  backOffProviderEndpoint(endpoint: string, nextAllowedAt: string) {
    this.endpoints.set(endpoint, nextAllowedAt);
  }
}

class FakeRpc implements StdioRpc {
  readonly calls: RpcExchange[] = [];
  constructor(private readonly replies: (input: RpcExchange) => Map<number, RpcReply>) {}
  async exchange(input: RpcExchange): Promise<Map<number, RpcReply>> {
    this.calls.push(input);
    return this.replies(input);
  }
}

const CODEX_RESULT = {
  rateLimits: { limitId: "example-weekly" },
  rateLimitsByLimitId: {
    "example-weekly": {
      limitId: "example-weekly",
      limitName: "Example weekly allowance",
      primary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1_894_104_000 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      planType: "example-plan",
    },
    "example-burst": {
      limitId: "example-burst",
      limitName: "Example burst allowance",
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_893_517_200 },
      secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_894_104_000 },
      credits: null,
      planType: "example-plan",
      spendControlReached: true,
    },
  },
};

const GROK_BILLING = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2030-01-01T12:00:00.000000+00:00",
      end: "2030-01-08T12:00:00.000000+00:00",
    },
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    prepaidBalance: { val: 0 },
  },
  subscription_tier: "Example plan",
};

const GROK_SUBSCRIPTION = {
  authenticated: true,
  meta: {
    email: "person@example.com",
    team_id: "team-example",
    gate: null,
    subscription_tier: "Example plan",
  },
};

describe("codex quota source", () => {
  test("reports every metered bucket, not just the one the last turn used", async () => {
    const rpc = new FakeRpc(() => new Map([[2, { result: CODEX_RESULT }]]));
    const source = new CodexQuotaSource({ cache: new FakeCache(), rpc, now: () => NOW });

    const rows = await source.read();

    expect(rows.map((row) => [row.profile, row.source])).toEqual([
      ["example-burst", "probe"],
      ["example-weekly", "probe"],
    ]);
    expect(rows[0]?.windows).toEqual([
      { label: "5h", usedPercent: 0, resetsAt: "2030-01-01T17:00:00.000Z" },
      { label: "weekly", usedPercent: 40, resetsAt: "2030-01-08T12:00:00.000Z" },
    ]);
    expect(rows[1]?.windows).toEqual([
      { label: "weekly", usedPercent: 20, resetsAt: "2030-01-08T12:00:00.000Z" },
    ]);
    expect(rows[0]?.notes).toContain("Spend control reached for this bucket.");
    expect(rows[1]?.credits).toEqual({ hasCredits: false, unlimited: false, balance: "0" });
  });

  test("drives an ephemeral app-server and never the shared daemon", async () => {
    const rpc = new FakeRpc(() => new Map([[2, { result: CODEX_RESULT }]]));
    await new CodexQuotaSource({ cache: new FakeCache(), rpc, now: () => NOW }).read();

    const call = rpc.calls[0];
    expect(call?.args).toEqual(["app-server"]);
    expect(JSON.stringify(call?.args)).not.toContain("daemon");
    // Initialize, the initialized notification, then the read; the reply we wait for is id 2.
    expect(call?.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "account/rateLimits/read",
    ]);
    expect(call?.expect).toEqual([2]);
  });

  test("serves the cached buckets and refuses a second spawn inside the interval", async () => {
    const cache = new FakeCache();
    let calls = 0;
    const rpc = new FakeRpc(() => {
      calls += 1;
      return new Map([[2, { result: CODEX_RESULT }]]);
    });

    await new CodexQuotaSource({ cache, rpc, now: () => NOW }).read();
    await new CodexQuotaSource({ cache, rpc, now: () => NOW }).read();
    expect(calls).toBe(1);

    cache.entries.clear();
    const [cooling] = await new CodexQuotaSource({ cache, rpc, now: () => NOW }).read();
    expect(calls).toBe(1);
    expect(cooling?.source).toBe("unknown");
    expect(cooling?.notes?.[0]).toContain("cools down");
  });

  test("degrades to unknown when the codex binary is missing or the call fails", async () => {
    const missing = new FakeRpc(() => {
      throw new SpawnFailedError("codex", "spawn ENOENT");
    });
    const [absent] = await new CodexQuotaSource({
      cache: new FakeCache(),
      rpc: missing,
      now: () => NOW,
    }).read();

    expect(absent?.source).toBe("unknown");
    expect(absent?.notes?.[0]).toContain("could not be started");

    const refused = new FakeRpc(
      () => new Map([[2, { error: { code: -32_000, message: "Bearer RPC_SENTINEL_SECRET" } }]]),
    );
    const [failed] = await new CodexQuotaSource({
      cache: new FakeCache(),
      rpc: refused,
      now: () => NOW,
    }).read();

    expect(failed?.source).toBe("unknown");
    expect(failed?.notes?.[0]).toContain("RPC code -32000");
    expect(JSON.stringify(failed)).not.toContain("RPC_SENTINEL_SECRET");
  });

  test("--no-probe never spawns the app server", async () => {
    let calls = 0;
    const rpc = new FakeRpc(() => {
      calls += 1;
      return new Map();
    });

    const [row] = await new CodexQuotaSource({
      cache: new FakeCache(),
      rpc,
      now: () => NOW,
      allowInference: false,
    }).read();

    expect(calls).toBe(0);
    expect(row?.source).toBe("unknown");
    expect(row?.notes?.[0]).toContain("--no-probe");
  });
});

describe("grok quota source", () => {
  test("reports tier and the weekly window without inventing a percentage", async () => {
    const rpc = new FakeRpc(
      () =>
        new Map([
          [2, { result: GROK_BILLING }],
          [3, { result: GROK_SUBSCRIPTION }],
        ]),
    );

    const [row] = await new GrokQuotaSource({ cache: new FakeCache(), rpc, now: () => NOW }).read();

    expect(row?.source).toBe("probe");
    expect(row?.windows).toEqual([
      { label: "weekly", usedPercent: null, resetsAt: "2030-01-08T12:00:00.000Z" },
    ]);
    expect(row?.notes).toEqual([
      "Subscription tier: Example plan.",
      "No headroom metric published for this seat; the weekly window resets 2030-01-08T12:00:00.000Z.",
    ]);
    // Account identity is read but never reported.
    expect(JSON.stringify(row)).not.toContain("example.com");
    expect(JSON.stringify(row)).not.toContain("team-example");
  });

  test("computes a real percentage once on-demand credits give it a denominator", async () => {
    const rpc = new FakeRpc(
      () =>
        new Map([
          [
            2,
            {
              result: {
                ...GROK_BILLING,
                config: {
                  ...GROK_BILLING.config,
                  onDemandCap: { val: 200 },
                  onDemandUsed: { val: 40 },
                },
              },
            },
          ],
          [3, { result: GROK_SUBSCRIPTION }],
        ]),
    );

    const [row] = await new GrokQuotaSource({ cache: new FakeCache(), rpc, now: () => NOW }).read();

    expect(row?.windows[0]?.usedPercent).toBe(20);
    expect(row?.notes).toContain("On-demand: 40 of 200 used.");
  });

  test("degrades to unknown when the billing extension is not implemented", async () => {
    const rpc = new FakeRpc(
      () =>
        new Map([
          [2, { error: { code: -32601, message: "unknown ACP extension method" } }],
          [3, { error: { code: -32601, message: "unknown ACP extension method" } }],
        ]),
    );

    const [row] = await new GrokQuotaSource({ cache: new FakeCache(), rpc, now: () => NOW }).read();

    expect(row?.source).toBe("unknown");
    expect(row?.notes?.[0]).toContain("RPC code -32601");
  });

  test("does not expose Grok RPC error messages", async () => {
    const rpc = new FakeRpc(
      () =>
        new Map([
          [2, { error: { code: -32_000, message: "Bearer GROK_RPC_SENTINEL_SECRET" } }],
          [3, { error: { code: -32_000, message: "Bearer GROK_RPC_SENTINEL_SECRET" } }],
        ]),
    );

    const [row] = await new GrokQuotaSource({ cache: new FakeCache(), rpc, now: () => NOW }).read();

    expect(row?.notes?.[0]).toContain("RPC code -32000");
    expect(JSON.stringify(row)).not.toContain("GROK_RPC_SENTINEL_SECRET");
  });

  test("never creates a session and degrades when the binary is missing", async () => {
    const rpc = new FakeRpc(
      () =>
        new Map([
          [2, { result: GROK_BILLING }],
          [3, { result: GROK_SUBSCRIPTION }],
        ]),
    );
    await new GrokQuotaSource({ cache: new FakeCache(), rpc, now: () => NOW }).read();

    expect(rpc.calls[0]?.args).toEqual(["agent", "stdio"]);
    expect(rpc.calls[0]?.requests.some((request) => request.method === "session/new")).toBe(false);

    const missing = new FakeRpc(() => {
      throw new SpawnFailedError("grok", "spawn ENOENT");
    });
    const [absent] = await new GrokQuotaSource({
      cache: new FakeCache(),
      rpc: missing,
      now: () => NOW,
    }).read();

    expect(absent?.source).toBe("unknown");
    expect(absent?.notes?.[0]).toContain("could not be started");
  });
});
