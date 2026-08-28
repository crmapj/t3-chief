import { type ProviderLimits, parseCodexAppServerLimits } from "../domain/limits.ts";
import { ChildProcessRpc, SpawnFailedError, type StdioRpc } from "./agent-rpc.ts";
import type { ClaudeQuotaCache } from "./claude-quota.ts";

const CACHE_KEY = "codex:buckets";
const ENDPOINT = "codex/app-server";
const DEFAULT_TTL_SECONDS = 60;

export interface CodexQuotaSourceOptions {
  cache: ClaudeQuotaCache;
  rpc?: StdioRpc;
  now?: () => Date;
  ttlSeconds?: number;
  allowInference?: boolean;
  /** Resolved from PATH, or from `T3CHIEF_CODEX_BIN` when the CLI is installed elsewhere. */
  binary?: string;
  clientVersion?: string;
  timeoutMs?: number;
}

/**
 * Reads every Codex rate-limit bucket from an ephemeral `codex app-server`, the same RPC the Codex
 * TUI's /status uses. Costs no tokens and no quota, and writes no rollout.
 *
 * This is the primary Codex source because a rollout snapshot records only the bucket the last
 * turn used: one bucket can sit at 20% while the newest rollout reports 0% for other
 * provider-defined bucket IDs. The daemon (`codex app-server daemon start`) is deliberately not used, since
 * it shares state with any running fleet.
 */
export class CodexQuotaSource {
  private readonly cache: ClaudeQuotaCache;
  private readonly rpc: StdioRpc;
  private readonly now: () => Date;
  private readonly ttlSeconds: number;
  private readonly allowInference: boolean;
  private readonly binary: string;
  private readonly clientVersion: string;
  private readonly timeoutMs: number;

  constructor(options: CodexQuotaSourceOptions) {
    this.cache = options.cache;
    this.rpc = options.rpc ?? new ChildProcessRpc();
    this.now = options.now ?? (() => new Date());
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.allowInference = options.allowInference !== false;
    this.binary = options.binary ?? process.env.T3CHIEF_CODEX_BIN ?? "codex";
    this.clientVersion = options.clientVersion ?? "0.7.0";
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async read(): Promise<ProviderLimits[]> {
    const now = this.now();
    const at = now.toISOString();
    const cached = this.cache.readProviderLimit(CACHE_KEY, at);
    if (cached) return cached as ProviderLimits[];
    if (!this.allowInference) {
      return [unreadable("Skipped by --no-probe and no fresh cached reading exists.")];
    }
    if (
      !this.cache.reserveProviderEndpoint(
        ENDPOINT,
        at,
        new Date(now.getTime() + this.ttlSeconds * 1_000).toISOString(),
      )
    ) {
      return [
        unreadable("App server was queried moments ago; serving nothing until it cools down."),
      ];
    }

    let reply:
      | { result?: unknown; error?: { code?: number; message?: string } | undefined }
      | undefined;
    try {
      const replies = await this.rpc.exchange({
        command: this.binary,
        args: ["app-server"],
        requests: [
          {
            id: 1,
            method: "initialize",
            params: { clientInfo: { name: "t3chief", version: this.clientVersion } },
          },
          { method: "initialized" },
          { id: 2, method: "account/rateLimits/read" },
        ],
        expect: [2],
        timeoutMs: this.timeoutMs,
      });
      reply = replies.get(2);
    } catch (error) {
      return [unreadable(describe(error))];
    }
    if (!reply || reply.error) {
      return [
        unreadable(
          reply?.error
            ? `account/rateLimits/read failed (${rpcCode(reply.error.code)}).`
            : "account/rateLimits/read returned no reply.",
        ),
      ];
    }

    const buckets = parseCodexAppServerLimits(reply.result);
    if (buckets.length === 0) {
      return [unreadable("App server returned no rate-limit buckets.")];
    }
    const rows: ProviderLimits[] = buckets.map((bucket) => ({
      provider: "codex",
      profile: bucket.limitId,
      windows: bucket.windows,
      ...(bucket.credits ? { credits: bucket.credits } : {}),
      source: "probe" as const,
      observedAt: at,
      notes: [
        ...(bucket.limitName ? [`Bucket name: ${bucket.limitName}.`] : []),
        ...(bucket.planType ? [`Plan: ${bucket.planType}.`] : []),
        ...bucket.notes,
      ],
    }));
    this.cache.writeProviderLimit(
      CACHE_KEY,
      rows,
      at,
      new Date(now.getTime() + this.ttlSeconds * 1_000).toISOString(),
    );
    return rows;
  }
}

function describe(error: unknown): string {
  return error instanceof SpawnFailedError
    ? "Codex quota probe binary could not be started."
    : "Codex quota probe process failed.";
}

function rpcCode(code: unknown): string {
  return typeof code === "number" && Number.isSafeInteger(code) ? `RPC code ${code}` : "RPC error";
}

function unreadable(note: string): ProviderLimits {
  return { provider: "codex", windows: [], source: "unknown", observedAt: null, notes: [note] };
}
