import { describe, expect, test } from "bun:test";

import { type FetchLike, T3V1Client, validateModelSelection } from "../src/adapters/t3-v1.ts";

const descriptor = {
  environmentId: "env-1",
  label: "test",
  serverVersion: "1.0.0",
  platform: { os: "linux", arch: "x64" },
  capabilities: { threadSettlement: true },
};

const config = {
  environment: descriptor,
  threadSnapshotPagination: true,
  providers: [
    {
      instanceId: "codex-work",
      driver: "codex",
      enabled: true,
      installed: true,
      availability: "available",
      status: "ready",
      auth: { status: "authenticated" },
      models: [
        {
          slug: "gpt-test",
          name: "GPT Test",
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select",
                options: [{ id: "low" }, { id: "high" }],
                currentValue: "low",
              },
              { id: "fastMode", label: "Fast mode", type: "boolean" },
            ],
          },
        },
      ],
    },
  ],
};

describe("T3 V1 client", () => {
  test("requires HTTPS and its derived WSS transport away from loopback", () => {
    expect(() => new T3V1Client({ baseUrl: "http://t3.example", bearerToken: "secret" })).toThrow(
      "requires HTTPS",
    );
    expect(
      () =>
        new T3V1Client({
          baseUrl: "http://t3.example",
          bearerToken: "secret",
          allowInsecure: true,
        }),
    ).not.toThrow();
    expect(
      () => new T3V1Client({ baseUrl: "http://127.0.0.1:3787", bearerToken: "secret" }),
    ).not.toThrow();
  });

  test("loads bounded thread context with bearer auth", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: FetchLike = async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/.well-known/t3/environment")) return Response.json(descriptor);
      if (url.includes("/api/orchestration/threads/thread-1")) {
        return Response.json({ snapshotSequence: 1, thread: { id: "thread-1", messages: [] } });
      }
      return new Response("not found", { status: 404 });
    };
    const client = new T3V1Client({
      baseUrl: "http://t3.test/",
      bearerToken: "secret",
      allowInsecure: true,
      fetcher,
      rpc: { request: async () => config },
    });

    await client.thread("thread-1", { turnLimit: 50 });

    expect(requests[0]?.url).toBe("http://t3.test/api/orchestration/threads/thread-1?turnLimit=50");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer secret");
  });

  test("normalizes and validates the live provider option schema", async () => {
    const client = new T3V1Client({
      baseUrl: "http://t3.test",
      bearerToken: "secret",
      allowInsecure: true,
      fetcher: async () => Response.json(descriptor),
      rpc: { request: async () => config },
    });

    const catalog = await client.catalog();
    expect(catalog.providers[0]?.instanceId).toBe("codex-work");
    expect(catalog.providers[0]).toEqual(
      expect.objectContaining({
        enabled: true,
        installed: true,
        availability: "available",
        authStatus: "authenticated",
      }),
    );
    expect(catalog.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(
      validateModelSelection(catalog, {
        instanceId: "codex-work",
        model: "gpt-test",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      }),
    ).toEqual([]);
    expect(
      validateModelSelection(catalog, {
        instanceId: "codex-work",
        model: "gpt-test",
        options: [{ id: "reasoningEffort", value: "ultra" }],
      }),
    ).toEqual([expect.objectContaining({ code: "OPTION_VALUE_INVALID" })]);
  });

  test("fails closed when an advertised provider is disabled or unavailable", async () => {
    const client = new T3V1Client({
      baseUrl: "http://t3.test",
      bearerToken: "secret",
      allowInsecure: true,
      fetcher: async () => Response.json(descriptor),
      rpc: {
        request: async () => ({
          ...config,
          providers: [
            {
              ...config.providers[0],
              enabled: false,
              installed: false,
              availability: "unavailable",
              status: "disabled",
              auth: { status: "unauthenticated" },
            },
          ],
        }),
      },
    });

    const issues = validateModelSelection(await client.catalog(), {
      instanceId: "codex-work",
      model: "gpt-test",
    });

    expect(issues.map((issue) => issue.code)).toEqual([
      "PROVIDER_DISABLED",
      "PROVIDER_NOT_INSTALLED",
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_NOT_READY",
      "PROVIDER_UNAUTHENTICATED",
    ]);
  });

  test("dispatches commands through the bootstrap-aware WebSocket RPC", async () => {
    const requests: Array<{ tag: string; payload: unknown }> = [];
    const client = new T3V1Client({
      baseUrl: "http://t3.test",
      bearerToken: "secret",
      allowInsecure: true,
      fetcher: async () => Response.json(descriptor),
      rpc: {
        request: async (tag, payload) => {
          requests.push({ tag, payload });
          return { commandId: "command-1", status: "accepted" };
        },
      },
    });

    const receipt = await client.dispatch({
      type: "thread.settle",
      commandId: "command-1",
      threadId: "thread-1",
    });

    expect(requests).toEqual([
      {
        tag: "orchestration.dispatchCommand",
        payload: { type: "thread.settle", commandId: "command-1", threadId: "thread-1" },
      },
    ]);
    expect(receipt).toEqual({ commandId: "command-1", status: "accepted" });
  });
});
