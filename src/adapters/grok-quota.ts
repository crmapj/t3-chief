import { type ProviderLimits, parseGrokQuota } from "../domain/limits.ts";
import { ChildProcessRpc, SpawnFailedError, type StdioRpc } from "./agent-rpc.ts";
import type { ClaudeQuotaCache } from "./claude-quota.ts";

const CACHE_KEY = "grok:billing";
const ENDPOINT = "grok/agent-stdio";
const DEFAULT_TTL_SECONDS = 60;

export interface GrokQuotaSourceOptions {
  cache: ClaudeQuotaCache;
  rpc?: StdioRpc;
  now?: () => Date;
  ttlSeconds?: number;
  allowInference?: boolean;
  /** Resolved from PATH, or from `T3CHIEF_GROK_BIN` when the CLI is installed elsewhere. */
  binary?: string;
  timeoutMs?: number;
}

/**
 * Reads subscription state from an ephemeral `grok agent stdio` through xAI's `_x.ai/billing` and
 * `_x.ai/auth/check_subscription` ACP extensions. Costs no tokens.
 *
 * Both extensions are undocumented and the CLI self-updates, so every field is optional and an
 * unknown-method error degrades to `unknown` rather than failing the command. `session/new` is
 * deliberately never called: it would create session directories as a side effect.
 */
export class GrokQuotaSource {
  private readonly cache: ClaudeQuotaCache;
  private readonly rpc: StdioRpc;
  private readonly now: () => Date;
  private readonly ttlSeconds: number;
  private readonly allowInference: boolean;
  private readonly binary: string;
  private readonly timeoutMs: number;

  constructor(options: GrokQuotaSourceOptions) {
    this.cache = options.cache;
    this.rpc = options.rpc ?? new ChildProcessRpc();
    this.now = options.now ?? (() => new Date());
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.allowInference = options.allowInference !== false;
    this.binary = options.binary ?? process.env.T3CHIEF_GROK_BIN ?? "grok";
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async read(): Promise<ProviderLimits[]> {
    const now = this.now();
    const at = now.toISOString();
    const cached = this.cache.readProviderLimit(CACHE_KEY, at);
    if (cached) return cached as ProviderLimits[];
    if (!this.allowInference) {
      return [unreadable("Skipped by --no-probe and no fresh cached reading exists.")];
    }
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1_000).toISOString();
    if (!this.cache.reserveProviderEndpoint(ENDPOINT, at, expiresAt)) {
      return [unreadable("Agent was queried moments ago; serving nothing until it cools down.")];
    }

    let billing: unknown;
    let subscription: unknown;
    try {
      const replies = await this.rpc.exchange({
        command: this.binary,
        args: ["agent", "stdio"],
        requests: [
          {
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: 1,
              clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
            },
          },
          { id: 2, method: "_x.ai/billing", params: {} },
          { id: 3, method: "_x.ai/auth/check_subscription", params: {} },
        ],
        expect: [2, 3],
        timeoutMs: this.timeoutMs,
      });
      const billingReply = replies.get(2);
      const subscriptionReply = replies.get(3);
      if (billingReply?.error && subscriptionReply?.error) {
        return [
          unreadable(
            `Billing extensions unavailable in this Grok build (${rpcCode(billingReply.error.code)}).`,
          ),
        ];
      }
      billing = billingReply?.result;
      subscription = subscriptionReply?.result;
    } catch (error) {
      return [unreadable(describe(error))];
    }

    const quota = parseGrokQuota(billing, subscription);
    if (!quota) return [unreadable("Billing extensions returned nothing usable.")];
    const row: ProviderLimits = {
      provider: "grok",
      windows: quota.windows,
      source: "probe",
      observedAt: at,
      notes: quota.notes,
    };
    this.cache.writeProviderLimit(CACHE_KEY, [row], at, expiresAt);
    return [row];
  }
}

function describe(error: unknown): string {
  return error instanceof SpawnFailedError
    ? "Grok quota probe binary could not be started."
    : "Grok quota probe process failed.";
}

function rpcCode(code: unknown): string {
  return typeof code === "number" && Number.isSafeInteger(code) ? `RPC code ${code}` : "RPC error";
}

function unreadable(note: string): ProviderLimits {
  return { provider: "grok", windows: [], source: "unknown", observedAt: null, notes: [note] };
}
