import type { ClaudeProfileConfig, CommandRunner } from "../config.ts";
import {
  claudeUserAgent,
  type LimitWindow,
  type ProviderLimits,
  parseOAuthUsage,
  parseUnifiedRateLimitHeaders,
  type QuotaReading,
  retryAfterSeconds,
} from "../domain/limits.ts";
import type { FetchLike } from "./t3-v1.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";
/** One token is the smallest request the API accepts, and it is what the probe spends. */
const PROBE_BODY = {
  model: "claude-haiku-4-5",
  max_tokens: 1,
  messages: [{ role: "user", content: "quota" }],
};

const DEFAULT_TTL_SECONDS = 300;
/** Never call the endpoints faster than this, whatever the TTL says. */
const MIN_INTERVAL_SECONDS = 180;
const DEFAULT_BACKOFF_SECONDS = 900;
const USER_AGENT_TTL_SECONDS = 86_400;

/**
 * Structural subset of the ledger. Reservations are atomic there, which is what serializes
 * concurrent t3chief processes.
 */
export interface ClaudeQuotaCache {
  readProviderLimit(cacheKey: string, now: string): unknown | null;
  writeProviderLimit(
    cacheKey: string,
    payload: unknown,
    observedAt: string,
    expiresAt: string,
  ): void;
  reserveProviderEndpoint(endpoint: string, now: string, nextAllowedAt: string): boolean;
  backOffProviderEndpoint(
    endpoint: string,
    nextAllowedAt: string,
    status: string,
    now: string,
  ): void;
}

export interface StatuslineReader {
  read(profile: string): { reading: QuotaReading; capturedAt: string } | null;
}

export interface ClaudeQuotaSourceOptions {
  profiles: readonly ClaudeProfileConfig[];
  cache: ClaudeQuotaCache;
  runCommand: CommandRunner;
  fetcher?: FetchLike;
  statusline?: StatuslineReader;
  now?: () => Date;
  ttlSeconds?: number;
  minIntervalSeconds?: number;
  /** False under `--no-probe`: cached and statusline readings still count, network calls do not. */
  allowInference?: boolean;
  timeoutMs?: number;
  versionCommand?: string;
}

interface Attempt {
  reading: QuotaReading;
  source: "oauth-usage" | "probe";
  notes: string[];
}

function isoAfter(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1_000).toISOString();
}

function statusNote(status: string | null): string[] {
  return status && status !== "allowed" ? [`Provider unified status: ${status}.`] : [];
}

/**
 * Reads real Claude quota per configured profile.
 *
 * Order per profile: cached reading, then Claude Code's statusline cache, then
 * `GET /api/oauth/usage`, then a one-token inference call whose response headers carry the same
 * numbers. Setup tokens are inference-scoped and answer the usage endpoint with 403, which is why
 * the header path exists. Both endpoints are internal surfaces, so every parse is defensive and
 * any failure leaves the caller on its transcript estimate rather than on a fabricated number.
 */
export class ClaudeQuotaSource {
  private readonly options: Required<
    Pick<ClaudeQuotaSourceOptions, "ttlSeconds" | "minIntervalSeconds" | "timeoutMs">
  > &
    ClaudeQuotaSourceOptions;
  private readonly now: () => Date;
  private userAgent: string | null = null;

  constructor(options: ClaudeQuotaSourceOptions) {
    this.options = {
      ttlSeconds: options.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      minIntervalSeconds: options.minIntervalSeconds ?? MIN_INTERVAL_SECONDS,
      timeoutMs: options.timeoutMs ?? 20_000,
      ...options,
    };
    this.now = options.now ?? (() => new Date());
  }

  async read(): Promise<ProviderLimits[]> {
    const rows: ProviderLimits[] = [];
    for (const profile of this.options.profiles) {
      rows.push(await this.readProfile(profile));
    }
    return rows;
  }

  private async readProfile(profile: ClaudeProfileConfig): Promise<ProviderLimits> {
    const now = this.now();
    const at = now.toISOString();
    const cacheKey = `claude:${profile.name}`;
    const cached = this.options.cache.readProviderLimit(cacheKey, at);
    if (cached) return cached as ProviderLimits;

    const statusline = this.options.statusline?.read(profile.name);
    if (
      statusline &&
      Date.parse(statusline.capturedAt) >= now.getTime() - this.options.ttlSeconds * 1_000
    ) {
      return this.store(cacheKey, now, {
        provider: "claude",
        profile: profile.name,
        windows: statusline.reading.windows,
        source: "statusline",
        observedAt: statusline.capturedAt,
        notes: statusNote(statusline.reading.status),
      });
    }

    if (this.options.allowInference === false) {
      return unreadable(profile.name, "Skipped by --no-probe and no fresh cached reading exists.");
    }

    const endpoint = `claude/${profile.name}`;
    if (
      !this.options.cache.reserveProviderEndpoint(
        endpoint,
        at,
        isoAfter(now, this.options.minIntervalSeconds),
      )
    ) {
      return unreadable(
        profile.name,
        "Endpoint is cooling down; another probe ran recently. Retry after the interval.",
      );
    }

    let token: string;
    try {
      token = await this.token(profile);
    } catch (error) {
      return unreadable(profile.name, describe(error));
    }

    let attempt: Attempt | null;
    try {
      attempt = await this.probe(token, endpoint, now);
    } catch (error) {
      return unreadable(profile.name, `Quota probe failed: ${describe(error)}`);
    }
    if (!attempt) {
      return unreadable(profile.name, "Neither the usage endpoint nor the header probe answered.");
    }
    return this.store(cacheKey, now, {
      provider: "claude",
      profile: profile.name,
      windows: attempt.reading.windows,
      source: attempt.source,
      observedAt: at,
      notes: [...attempt.notes, ...statusNote(attempt.reading.status)],
    });
  }

  private store(cacheKey: string, now: Date, row: ProviderLimits): ProviderLimits {
    this.options.cache.writeProviderLimit(
      cacheKey,
      row,
      row.observedAt ?? now.toISOString(),
      isoAfter(now, this.options.ttlSeconds),
    );
    return row;
  }

  private async token(profile: ClaudeProfileConfig): Promise<string> {
    const [executable, ...args] = profile.tokenCommand;
    if (!executable) throw new Error(`Profile '${profile.name}' has no token command.`);
    const result = await this.options.runCommand(executable, args);
    if (result.exitCode !== 0) {
      // Deliberately not echoing stderr: a misconfigured command could print the token there.
      throw new Error(`Token command for '${profile.name}' exited ${result.exitCode}.`);
    }
    const token = result.stdout.trim();
    if (token.length === 0) throw new Error(`Token command for '${profile.name}' printed nothing.`);
    return token;
  }

  private async probe(token: string, endpoint: string, now: Date): Promise<Attempt | null> {
    const fetcher = this.options.fetcher ?? fetch;
    const headers = {
      authorization: `Bearer ${token}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": OAUTH_BETA,
      // Anthropic throttles the usage endpoint hard and stickily without a client user agent.
      "user-agent": await this.resolveUserAgent(),
    };

    const usage = await fetcher(USAGE_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (usage.status === 429) {
      this.backOff(endpoint, usage, now, "usage-429");
      return null;
    }
    if (usage.ok) {
      const reading = parseOAuthUsage(await safeJson(usage));
      if (reading) return { reading, source: "oauth-usage", notes: [] };
    }

    const probe = await fetcher(MESSAGES_URL, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(PROBE_BODY),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (probe.status === 429) {
      this.backOff(endpoint, probe, now, "messages-429");
      return null;
    }
    const reading = parseUnifiedRateLimitHeaders(probe.headers);
    if (!reading) return null;
    return {
      reading,
      source: "probe",
      notes: [
        usage.status === 403
          ? "Usage endpoint refused this token's scope; read from inference response headers instead."
          : `Usage endpoint answered ${usage.status}; read from inference response headers instead.`,
      ],
    };
  }

  private backOff(endpoint: string, response: Response, now: Date, status: string): void {
    const seconds =
      retryAfterSeconds(response.headers.get("retry-after"), now) ?? DEFAULT_BACKOFF_SECONDS;
    this.options.cache.backOffProviderEndpoint(
      endpoint,
      isoAfter(now, Math.max(seconds, this.options.minIntervalSeconds)),
      status,
      now.toISOString(),
    );
  }

  private async resolveUserAgent(): Promise<string> {
    if (this.userAgent) return this.userAgent;
    const at = this.now().toISOString();
    const cached = this.options.cache.readProviderLimit("claude:user-agent", at);
    if (typeof cached === "string") {
      this.userAgent = cached;
      return cached;
    }
    let agent = "claude-code";
    try {
      const result = await this.options.runCommand(this.options.versionCommand ?? "claude", [
        "--version",
      ]);
      if (result.exitCode === 0) agent = claudeUserAgent(result.stdout);
    } catch {
      // A missing Claude Code install is fine; the generic agent still identifies the client.
    }
    this.options.cache.writeProviderLimit(
      "claude:user-agent",
      agent,
      at,
      isoAfter(this.now(), USER_AGENT_TTL_SECONDS),
    );
    this.userAgent = agent;
    return agent;
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unreadable(profile: string, note: string): ProviderLimits {
  return {
    provider: "claude",
    profile,
    windows: [] as LimitWindow[],
    source: "unknown",
    observedAt: null,
    notes: [note],
  };
}
