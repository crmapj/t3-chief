import { describe, expect, test } from "bun:test";

import { ChildProcessRpc, SpawnFailedError } from "../src/adapters/agent-rpc.ts";

/**
 * Stands in for an agent server: it answers only after a delay, and it exits immediately if stdin
 * reaches EOF. A transport that closed stdin after writing would therefore never get a reply.
 */
const SERVER = `
let buffer = "";
process.stdin.on("end", () => process.exit(7));
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (!buffer.includes('"id":2')) return;
  process.stdout.write("not json\\n");
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ready: true } }) + "\\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: 42 } }) + "\\n");
  }, 60);
});
`;

const REQUESTS = [
  { id: 1, method: "initialize" },
  { method: "initialized" },
  { id: 2, method: "account/rateLimits/read" },
];

describe("child process rpc", () => {
  test("keeps stdin open until the reply arrives and skips non-JSON output", async () => {
    const replies = await new ChildProcessRpc().exchange({
      command: process.execPath,
      args: ["-e", SERVER],
      requests: REQUESTS,
      expect: [2],
      timeoutMs: 5_000,
    });

    expect(replies.get(2)).toEqual({ result: { ok: 42 }, error: undefined });
  });

  test("waits for every expected id", async () => {
    const replies = await new ChildProcessRpc().exchange({
      command: process.execPath,
      args: ["-e", SERVER],
      requests: REQUESTS,
      expect: [1, 2],
      timeoutMs: 5_000,
    });

    expect([...replies.keys()].sort()).toEqual([1, 2]);
  });

  test("reports a missing binary as a spawn failure", async () => {
    expect(
      new ChildProcessRpc().exchange({
        command: "t3chief-no-such-provider-cli",
        args: [],
        requests: REQUESTS,
        expect: [2],
        timeoutMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(SpawnFailedError);
  });

  test("fails rather than hanging when the server never answers", async () => {
    expect(
      new ChildProcessRpc().exchange({
        command: process.execPath,
        args: ["-e", 'process.stdin.on("data", () => {});'],
        requests: REQUESTS,
        expect: [2],
        timeoutMs: 150,
      }),
    ).rejects.toThrow("did not reply within the timeout");
  });

  test("fails when the server exits before replying", async () => {
    expect(
      new ChildProcessRpc().exchange({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        requests: REQUESTS,
        expect: [2],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("closed before replying");
  });
});
