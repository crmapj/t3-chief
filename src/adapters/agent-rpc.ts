import { spawn } from "node:child_process";

export interface RpcRequest {
  /** Omit for notifications, which get no reply. */
  id?: number;
  method: string;
  params?: unknown;
}

export interface RpcReply {
  result?: unknown;
  error?: { code?: number; message?: string } | undefined;
}

export interface RpcExchange {
  command: string;
  args: string[];
  requests: RpcRequest[];
  /** Ids to wait for. The exchange ends as soon as all of them have replied. */
  expect: number[];
  timeoutMs?: number;
  cwd?: string;
}

/** Injected so tests never spawn a real provider CLI. */
export interface StdioRpc {
  exchange(input: RpcExchange): Promise<Map<number, RpcReply>>;
}

export class SpawnFailedError extends Error {
  constructor(command: string, cause: string) {
    super(`Could not run '${command}': ${cause}`);
    this.name = "SpawnFailedError";
  }
}

/**
 * Line-delimited JSON-RPC over a short-lived child process.
 *
 * stdin is deliberately left open until every expected reply has arrived: these agent servers
 * treat EOF on stdin as a shutdown signal, so a plain `printf | cmd` pipe exits before answering.
 */
export class ChildProcessRpc implements StdioRpc {
  async exchange(input: RpcExchange): Promise<Map<number, RpcReply>> {
    const replies = new Map<number, RpcReply>();
    const expected = new Set(input.expect);
    const child = spawn(input.command, input.args, {
      stdio: ["pipe", "pipe", "ignore"],
      cwd: input.cwd ?? "/tmp",
    });
    try {
      return await new Promise<Map<number, RpcReply>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`'${input.command}' did not reply within the timeout.`));
        }, input.timeoutMs ?? 20_000);
        const finish = (settle: () => void) => {
          clearTimeout(timeout);
          settle();
        };

        child.on("error", (error) =>
          finish(() => reject(new SpawnFailedError(input.command, error.message))),
        );
        child.on("close", () =>
          finish(() =>
            expected.size === 0
              ? resolve(replies)
              : reject(new Error(`'${input.command}' closed before replying.`)),
          ),
        );

        let buffer = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            let message: Record<string, unknown>;
            try {
              message = JSON.parse(line) as Record<string, unknown>;
            } catch {
              continue;
            }
            const id = message.id;
            if (typeof id !== "number" || !expected.has(id)) continue;
            replies.set(id, {
              result: message.result,
              error: message.error as RpcReply["error"],
            });
            expected.delete(id);
            if (expected.size === 0) finish(() => resolve(replies));
          }
        });

        for (const request of input.requests) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...request })}\n`);
        }
        // No stdin.end(): closing it would shut the server down before it answers.
      });
    } finally {
      child.kill("SIGKILL");
    }
  }
}
