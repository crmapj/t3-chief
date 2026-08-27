/**
 * Provider quota reporting. Every field a caller sees is either read from a provider artifact or
 * derived from one; nothing here invents a quota. `source` states how much the numbers are worth.
 */

export type LimitSource =
  | "exact-snapshot"
  | "oauth-usage"
  | "probe"
  | "statusline"
  | "estimate"
  | "signal"
  | "unknown";

/** Authority order, strongest first. Callers should prefer the earliest source they can get. */
export const LIMIT_SOURCE_AUTHORITY: readonly LimitSource[] = [
  "exact-snapshot",
  "oauth-usage",
  "probe",
  "statusline",
  "signal",
  "estimate",
  "unknown",
];

export interface LimitWindow {
  label: string;
  /** Null when the provider exposes no quota denominator on this host. */
  usedPercent: number | null;
  /** RFC3339, or null for a rolling window that never resets as a block. */
  resetsAt: string | null;
}

export interface LimitCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface ClaudeUsageSummary {
  requests: number;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  profiles: string[];
  models: string[];
  windowStartedAt: string;
}

export interface ProviderLimits {
  provider: string;
  /** Set when one provider account has several independently metered profiles. */
  profile?: string;
  windows: LimitWindow[];
  credits?: LimitCredits;
  source: LimitSource;
  /** RFC3339 of the underlying observation, not of this command run. */
  observedAt: string | null;
  notes?: string[];
  /** Present only for token-derived estimates, so callers can recompute a percentage. */
  usage?: ClaudeUsageSummary;
}

export interface LimitsReport {
  at: string;
  providers: ProviderLimits[];
}

/** Human label for a rate-limit window, for example 300 -> "5h" and 10080 -> "weekly". */
export function windowLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "unknown";
  if (minutes === 10_080) return "weekly";
  if (minutes === 1_440) return "daily";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function epochSecondsToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function percent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseWindow(raw: unknown): LimitWindow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.window_minutes !== "number") return null;
  return {
    label: windowLabel(record.window_minutes),
    usedPercent: percent(record.used_percent),
    resetsAt: epochSecondsToIso(record.resets_at),
  };
}

function parseCredits(raw: unknown): LimitCredits | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  return {
    hasCredits: record.has_credits === true,
    unlimited: record.unlimited === true,
    balance: typeof record.balance === "string" ? record.balance : null,
  };
}

export interface CodexLimitSnapshot {
  observedAt: string;
  windows: LimitWindow[];
  credits: LimitCredits | null;
  limitName: string | null;
  /** Which metered bucket this snapshot covers. A rollout only ever records one. */
  limitId: string | null;
}

/**
 * Read one Codex rollout JSONL line. Codex attaches `rate_limits` to its `token_count` events, so
 * the newest such line in the newest rollout is the freshest exact quota reading on the host.
 */
export function parseCodexRateLimitLine(line: string): CodexLimitSnapshot | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.includes("rate_limits")) return null;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const payload = event.payload as Record<string, unknown> | undefined;
  const limits = payload?.rate_limits as Record<string, unknown> | undefined;
  if (typeof limits !== "object" || limits === null) return null;
  const windows = [parseWindow(limits.primary), parseWindow(limits.secondary)].filter(
    (window): window is LimitWindow => window !== null,
  );
  if (windows.length === 0) return null;
  const timestamp = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : Number.NaN;
  return {
    observedAt: Number.isNaN(timestamp) ? "" : new Date(timestamp).toISOString(),
    windows,
    credits: parseCredits(limits.credits),
    limitName: typeof limits.limit_name === "string" ? limits.limit_name : null,
    limitId: typeof limits.limit_id === "string" ? limits.limit_id : null,
  };
}

/** Newest snapshot wins; a snapshot without a usable timestamp never displaces a dated one. */
export function newerCodexSnapshot(
  current: CodexLimitSnapshot | null,
  candidate: CodexLimitSnapshot | null,
): CodexLimitSnapshot | null {
  if (!candidate) return current;
  if (!current) return candidate;
  if (candidate.observedAt === "") return current;
  if (current.observedAt === "") return candidate;
  return candidate.observedAt > current.observedAt ? candidate : current;
}

export interface ClaudeUsageRow {
  key: string;
  profile: string;
  model: string | null;
  at: string;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Extract billable usage rows from Claude Code transcript lines inside `[since, until]`.
 *
 * Transcripts repeat one API response across several records while a message streams, so `key`
 * carries the message ID for later de-duplication. Counting raw lines overstates usage ~3x.
 */
export function parseClaudeUsageLines(
  lines: Iterable<string>,
  input: { profile: string; since: string; until: string },
): ClaudeUsageRow[] {
  const since = Date.parse(input.since);
  const until = Date.parse(input.until);
  const rows: ClaudeUsageRow[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.includes('"usage"')) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = record.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    if (typeof usage !== "object" || usage === null) continue;
    const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
    if (Number.isNaN(at) || at < since || at > until) continue;
    const identity =
      (typeof message?.id === "string" ? message.id : null) ??
      (typeof record.requestId === "string" ? record.requestId : null) ??
      (typeof record.uuid === "string" ? record.uuid : null);
    if (!identity) continue;
    rows.push({
      key: `${input.profile}:${identity}`,
      profile: input.profile,
      model: typeof message?.model === "string" ? message.model : null,
      at: new Date(at).toISOString(),
      inputTokens: count(usage.input_tokens),
      cacheCreationInputTokens: count(usage.cache_creation_input_tokens),
      cacheReadInputTokens: count(usage.cache_read_input_tokens),
      outputTokens: count(usage.output_tokens),
    });
  }
  return rows;
}

export function summarizeClaudeUsage(
  rows: readonly ClaudeUsageRow[],
  windowStartedAt: string,
): ClaudeUsageSummary {
  const seen = new Set<string>();
  const profiles = new Set<string>();
  const models = new Set<string>();
  const summary: ClaudeUsageSummary = {
    requests: 0,
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    profiles: [],
    models: [],
    windowStartedAt: windowStartedAt,
  };
  for (const row of rows) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    summary.requests += 1;
    summary.inputTokens += row.inputTokens;
    summary.cacheCreationInputTokens += row.cacheCreationInputTokens;
    summary.cacheReadInputTokens += row.cacheReadInputTokens;
    summary.outputTokens += row.outputTokens;
    profiles.add(row.profile);
    if (row.model) models.add(row.model);
  }
  summary.totalTokens =
    summary.inputTokens +
    summary.cacheCreationInputTokens +
    summary.cacheReadInputTokens +
    summary.outputTokens;
  summary.profiles = [...profiles].sort();
  summary.models = [...models].sort();
  return summary;
}

/** Percentage of a caller-supplied budget, rounded to one decimal. Null when uncalibrated. */
export function budgetPercent(totalTokens: number, budget: number | null): number | null {
  if (budget === null || !Number.isFinite(budget) || budget <= 0) return null;
  return Math.round((totalTokens / budget) * 1_000) / 10;
}

export interface HeaderLookup {
  get(name: string): string | null;
}

export interface QuotaReading {
  windows: LimitWindow[];
  status: string | null;
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Accepts epoch seconds (number or numeric string) or an RFC3339 string. */
export function toIsoInstant(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return epochSecondsToIso(value);
  if (typeof value !== "string" || value.trim().length === 0) return null;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return epochSecondsToIso(Number(value));
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Anthropic's unified rate-limit response headers. Utilization arrives as a 0..1 fraction and
 * resets as epoch seconds; both are normalized here so every source emits the same shape.
 */
export function parseUnifiedRateLimitHeaders(headers: HeaderLookup): QuotaReading | null {
  const windows: LimitWindow[] = [];
  for (const [prefix, label] of [
    ["5h", "5h"],
    ["7d", "weekly"],
  ] as const) {
    const utilization = numeric(headers.get(`anthropic-ratelimit-unified-${prefix}-utilization`));
    if (utilization === null) continue;
    windows.push({
      label,
      usedPercent: roundPercent(utilization * 100),
      resetsAt: toIsoInstant(headers.get(`anthropic-ratelimit-unified-${prefix}-reset`)),
    });
  }
  if (windows.length === 0) return null;
  return { windows, status: headers.get("anthropic-ratelimit-unified-status") };
}

/**
 * `GET /api/oauth/usage`. Utilization is already a 0..100 percentage here and `resets_at` is
 * RFC3339, unlike the response headers. Every field is nullish in practice, so each is optional.
 */
export function parseOAuthUsage(payload: unknown): QuotaReading | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const windows: LimitWindow[] = [];
  for (const [key, label] of [
    ["five_hour", "5h"],
    ["seven_day", "weekly"],
  ] as const) {
    const entry = record[key] as Record<string, unknown> | undefined;
    if (typeof entry !== "object" || entry === null) continue;
    const utilization = numeric(entry.utilization ?? entry.used_percentage);
    if (utilization === null) continue;
    windows.push({
      label,
      usedPercent: roundPercent(utilization),
      resetsAt: toIsoInstant(entry.resets_at),
    });
  }
  if (windows.length === 0) return null;
  return { windows, status: typeof record.status === "string" ? record.status : null };
}

/**
 * Claude Code's statusline stdin payload. `rate_limits` appears only in TUI sessions on a paid
 * plan and only after the first response, so absence is normal rather than an error.
 */
export function parseStatuslinePayload(payload: unknown): QuotaReading | null {
  if (typeof payload !== "object" || payload === null) return null;
  const limits = (payload as Record<string, unknown>).rate_limits;
  if (typeof limits !== "object" || limits === null) return null;
  const record = limits as Record<string, unknown>;
  const windows: LimitWindow[] = [];
  for (const [key, label] of [
    ["five_hour", "5h"],
    ["seven_day", "weekly"],
  ] as const) {
    const entry = record[key] as Record<string, unknown> | undefined;
    if (typeof entry !== "object" || entry === null) continue;
    const used = numeric(entry.used_percentage ?? entry.utilization);
    if (used === null) continue;
    windows.push({
      label,
      usedPercent: roundPercent(used),
      resetsAt: toIsoInstant(entry.resets_at),
    });
  }
  if (windows.length === 0) return null;
  return { windows, status: typeof record.status === "string" ? record.status : null };
}

/** `Retry-After` is either a delay in seconds or an HTTP date. Returns seconds from `now`. */
export function retryAfterSeconds(value: string | null, now: Date): number | null {
  if (value === null || value.trim().length === 0) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
  const until = Date.parse(value);
  if (Number.isNaN(until)) return null;
  return Math.max(0, Math.round((until - now.getTime()) / 1_000));
}

/** Claude Code reports its version as "2.1.234 (Claude Code)". */
export function claudeUserAgent(versionOutput: string): string {
  const version = versionOutput.trim().match(/\d+\.\d+\.\d+[^\s]*/)?.[0];
  return version ? `claude-code/${version}` : "claude-code";
}

export interface CodexBucket {
  limitId: string;
  limitName: string | null;
  windows: LimitWindow[];
  credits: LimitCredits | null;
  planType: string | null;
  notes: string[];
}

function parseAppServerWindow(raw: unknown): LimitWindow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.windowDurationMins !== "number") return null;
  return {
    label: windowLabel(record.windowDurationMins),
    usedPercent: percent(record.usedPercent),
    resetsAt: toIsoInstant(record.resetsAt),
  };
}

function parseAppServerCredits(raw: unknown): LimitCredits | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  return {
    hasCredits: record.hasCredits === true,
    unlimited: record.unlimited === true,
    balance: typeof record.balance === "string" ? record.balance : null,
  };
}

/**
 * `account/rateLimits/read` from the Codex app server. Unlike a rollout snapshot, which carries
 * only the bucket the last turn happened to use, this returns every metered bucket on the account.
 * Percentages are already 0..100 here and resets are epoch seconds.
 */
export function parseCodexAppServerLimits(result: unknown): CodexBucket[] {
  if (typeof result !== "object" || result === null) return [];
  const byLimitId = (result as Record<string, unknown>).rateLimitsByLimitId;
  if (typeof byLimitId !== "object" || byLimitId === null) return [];
  const buckets: CodexBucket[] = [];
  for (const [key, raw] of Object.entries(byLimitId as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const windows = [
      parseAppServerWindow(record.primary),
      parseAppServerWindow(record.secondary),
    ].filter((window): window is LimitWindow => window !== null);
    if (windows.length === 0) continue;
    const notes: string[] = [];
    if (record.spendControlReached === true) notes.push("Spend control reached for this bucket.");
    if (typeof record.rateLimitReachedType === "string") {
      notes.push(`Rate limit reached: ${record.rateLimitReachedType}.`);
    }
    buckets.push({
      limitId: typeof record.limitId === "string" ? record.limitId : key,
      limitName: typeof record.limitName === "string" ? record.limitName : null,
      windows,
      credits: parseAppServerCredits(record.credits),
      planType: typeof record.planType === "string" ? record.planType : null,
      notes,
    });
  }
  return buckets.sort((left, right) => left.limitId.localeCompare(right.limitId));
}

export interface GrokQuota {
  tier: string | null;
  windows: LimitWindow[];
  notes: string[];
  blocked: boolean;
}

function grokAmount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as Record<string, unknown>).val;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * xAI's undocumented `_x.ai/billing` and `_x.ai/auth/check_subscription` ACP extensions.
 *
 * A pure subscription seat publishes no remaining-headroom metric, so `usedPercent` stays null and the
 * window carries only its reset. A denominator exists only once on-demand credits are enabled, and
 * a percentage is reported only when the provider supplies one. Nothing here is derived from token
 * counts, and no account identity is copied out of the response.
 */
export function parseGrokQuota(billing: unknown, subscription: unknown): GrokQuota | null {
  const billingRecord =
    typeof billing === "object" && billing !== null ? (billing as Record<string, unknown>) : null;
  const subscriptionRecord =
    typeof subscription === "object" && subscription !== null
      ? (subscription as Record<string, unknown>)
      : null;
  if (!billingRecord && !subscriptionRecord) return null;

  const meta =
    typeof subscriptionRecord?.meta === "object" && subscriptionRecord.meta !== null
      ? (subscriptionRecord.meta as Record<string, unknown>)
      : null;
  const config =
    typeof billingRecord?.config === "object" && billingRecord.config !== null
      ? (billingRecord.config as Record<string, unknown>)
      : null;
  const period =
    typeof config?.currentPeriod === "object" && config.currentPeriod !== null
      ? (config.currentPeriod as Record<string, unknown>)
      : null;

  const tier =
    (typeof billingRecord?.subscription_tier === "string"
      ? billingRecord.subscription_tier
      : null) ?? (typeof meta?.subscription_tier === "string" ? meta.subscription_tier : null);

  const cap = grokAmount(config?.onDemandCap);
  const used = grokAmount(config?.onDemandUsed);
  const prepaid = grokAmount(config?.prepaidBalance);
  const published =
    typeof config?.creditUsagePercent === "number" ? config.creditUsagePercent : null;
  const usedPercent =
    published ?? (cap !== null && cap > 0 && used !== null ? (used / cap) * 100 : null);

  const resetsAt = toIsoInstant(period?.end ?? config?.billingPeriodEnd);
  const label =
    typeof period?.type === "string" && period.type.toUpperCase().includes("WEEKLY")
      ? "weekly"
      : "period";

  const notes: string[] = [];
  if (tier) notes.push(`Subscription tier: ${tier}.`);
  if (usedPercent === null) {
    notes.push(
      resetsAt
        ? `No headroom metric published for this seat; the ${label} window resets ${resetsAt}.`
        : "No headroom metric published for this seat.",
    );
  }
  if (cap !== null && cap > 0) {
    notes.push(`On-demand: ${used ?? 0} of ${cap} used.`);
  }
  if (prepaid !== null && prepaid > 0) notes.push(`Prepaid balance: ${prepaid}.`);

  const gate = meta?.gate;
  const blocked =
    subscriptionRecord?.authenticated === false || (gate !== null && gate !== undefined);
  if (subscriptionRecord?.authenticated === false) notes.push("Account is not authenticated.");
  if (gate !== null && gate !== undefined) notes.push(`Access gate active: ${String(gate)}.`);

  return {
    tier,
    windows: resetsAt || usedPercent !== null ? [{ label, usedPercent, resetsAt }] : [],
    notes,
    blocked,
  };
}
