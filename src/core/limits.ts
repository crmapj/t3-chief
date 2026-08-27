import {
  budgetPercent,
  type ClaudeUsageRow,
  type CodexLimitSnapshot,
  type LimitsReport,
  newerCodexSnapshot,
  type ProviderLimits,
  parseClaudeUsageLines,
  parseCodexRateLimitLine,
  summarizeClaudeUsage,
  windowLabel,
} from "../domain/limits.ts";

export const LIMITS_PROVIDERS = ["codex", "claude", "grok"] as const;
export type LimitsProvider = (typeof LIMITS_PROVIDERS)[number];

export interface LimitsFile {
  path: string;
  modifiedAt: string;
}

export interface ClaudeTranscriptFile extends LimitsFile {
  profile: string;
}

export interface LimitsTail {
  text: string;
  /** True when the file was longer than the tail budget, so the text is only its final slice. */
  truncated: boolean;
}

/** Read-only access to on-host provider artifacts. Injected so the core needs no real home dir. */
export interface LimitsSource {
  /** Codex rollout JSONL files, newest modification first. */
  codexRollouts(): Promise<LimitsFile[]>;
  /** Claude Code transcript JSONL files across every discovered profile. */
  claudeTranscripts(): Promise<ClaudeTranscriptFile[]>;
  /** Last `maxBytes` of a file, starting at a line boundary. Rollouts reach ~100 MB. */
  readTail(path: string, maxBytes: number): Promise<LimitsTail>;
}

/**
 * A privileged provider reading, for example an authenticated usage endpoint. One probe may return
 * several rows when an account has independently metered profiles. An empty result, or rows that
 * are all `unknown`, leaves the reporter on its local estimate.
 */
export interface ProviderProbe {
  read(input: { at: string }): Promise<ProviderLimits[] | null>;
}

export interface LimitsReporterOptions {
  source: LimitsSource;
  now?: () => Date;
  /** Trailing window used for the Claude token estimate. */
  claudeWindowMinutes?: number;
  /** Token denominator for the Claude estimate. Null keeps `usedPercent` honestly null. */
  claudeTokenBudget?: number | null;
  /** Newest rollouts inspected before giving up on an exact Codex snapshot. */
  codexRolloutScanLimit?: number;
  /** Codex only needs the final snapshot, so a small tail is enough even for a 100 MB rollout. */
  tailBytes?: number;
  /** Claude needs every turn inside the window, so its tail budget is larger. */
  claudeTailBytes?: number;
  probes?: { codex?: ProviderProbe; claude?: ProviderProbe; grok?: ProviderProbe };
}

const DEFAULT_CLAUDE_WINDOW_MINUTES = 300;
const DEFAULT_CODEX_SCAN_LIMIT = 5;
const DEFAULT_TAIL_BYTES = 1_048_576;
const DEFAULT_CLAUDE_TAIL_BYTES = 33_554_432;

export class LimitsReporter {
  private readonly source: LimitsSource;
  private readonly now: () => Date;
  private readonly claudeWindowMinutes: number;
  private readonly claudeTokenBudget: number | null;
  private readonly codexRolloutScanLimit: number;
  private readonly tailBytes: number;
  private readonly claudeTailBytes: number;
  private readonly probes: { codex?: ProviderProbe; claude?: ProviderProbe; grok?: ProviderProbe };

  constructor(options: LimitsReporterOptions) {
    this.source = options.source;
    this.now = options.now ?? (() => new Date());
    this.claudeWindowMinutes = options.claudeWindowMinutes ?? DEFAULT_CLAUDE_WINDOW_MINUTES;
    this.claudeTokenBudget = options.claudeTokenBudget ?? null;
    this.codexRolloutScanLimit = options.codexRolloutScanLimit ?? DEFAULT_CODEX_SCAN_LIMIT;
    this.tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
    this.claudeTailBytes = options.claudeTailBytes ?? DEFAULT_CLAUDE_TAIL_BYTES;
    this.probes = options.probes ?? {};
  }

  async report(input: { providers?: readonly string[] } = {}): Promise<LimitsReport> {
    const at = this.now().toISOString();
    const requested: readonly string[] = input.providers?.length
      ? input.providers
      : LIMITS_PROVIDERS;
    const unsupported = requested.filter(
      (name) => !LIMITS_PROVIDERS.includes(name as LimitsProvider),
    );
    if (unsupported.length > 0) {
      throw new Error(
        `Unknown provider(s) ${unsupported.join(", ")}; known providers are ${LIMITS_PROVIDERS.join(", ")}.`,
      );
    }
    const providers: ProviderLimits[] = [];
    for (const name of LIMITS_PROVIDERS) {
      if (!requested.includes(name)) continue;
      if (name === "codex") providers.push(...(await this.codex(at)));
      if (name === "claude") providers.push(...(await this.claude(at)));
      if (name === "grok") providers.push(...(await this.grok(at)));
    }
    return { at, providers };
  }

  /**
   * The app-server probe wins because it reports every metered bucket. A rollout snapshot records
   * only the bucket the last turn used, so on its own it can report 0% while another bucket on the
   * same account is nearly exhausted.
   */
  private async codex(at: string): Promise<ProviderLimits[]> {
    const probed = (await this.probes.codex?.read({ at })) ?? [];
    if (probed.some((row) => row.source !== "unknown")) return probed;
    return [...probed, await this.codexRollout(at)];
  }

  private async codexRollout(at: string): Promise<ProviderLimits> {
    let files: LimitsFile[];
    try {
      files = await this.source.codexRollouts();
    } catch (error) {
      return unavailable("codex", `Could not list Codex rollouts: ${describe(error)}`);
    }
    if (files.length === 0) {
      return unavailable("codex", "No Codex rollout files were found on this host.");
    }
    let snapshot: CodexLimitSnapshot | null = null;
    const scanned = files.slice(0, this.codexRolloutScanLimit);
    for (const file of scanned) {
      let tail: LimitsTail;
      try {
        tail = await this.source.readTail(file.path, this.tailBytes);
      } catch {
        continue;
      }
      const lines = tail.text.split("\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const parsed = parseCodexRateLimitLine(lines[index] ?? "");
        if (parsed) {
          snapshot = newerCodexSnapshot(snapshot, {
            ...parsed,
            observedAt: parsed.observedAt || file.modifiedAt,
          });
          break;
        }
      }
    }
    if (!snapshot) {
      return unavailable(
        "codex",
        `No rate_limits snapshot appeared in the newest ${scanned.length} Codex rollout tail(s); start a Codex turn to refresh it.`,
      );
    }
    const ageMinutes = Math.max(
      0,
      Math.round((Date.parse(at) - Date.parse(snapshot.observedAt)) / 60_000),
    );
    const notes = [
      "Single-bucket reading: a rollout records only the bucket its last turn used, so other buckets on this account are not covered.",
      `Observed ${ageMinutes} minute(s) ago; rollouts go stale for up to a session window.`,
      ...(snapshot.limitName ? [`Bucket name: ${snapshot.limitName}.`] : []),
    ];
    return {
      provider: "codex",
      ...(snapshot.limitId ? { profile: snapshot.limitId } : {}),
      windows: snapshot.windows,
      ...(snapshot.credits ? { credits: snapshot.credits } : {}),
      source: "exact-snapshot",
      observedAt: snapshot.observedAt,
      notes,
    };
  }

  /**
   * Probed rows win when at least one is authoritative. Rows the probe could not read are still
   * returned so a configured profile never disappears silently, and the transcript estimate is
   * appended only when nothing authoritative came back.
   */
  private async claude(at: string): Promise<ProviderLimits[]> {
    const probed = (await this.probes.claude?.read({ at })) ?? [];
    if (probed.some((row) => row.source !== "unknown")) return probed;
    return [...probed, await this.claudeEstimate(at)];
  }

  private async claudeEstimate(at: string): Promise<ProviderLimits> {
    const windowStartedAt = new Date(
      Date.parse(at) - this.claudeWindowMinutes * 60_000,
    ).toISOString();
    let files: ClaudeTranscriptFile[];
    try {
      files = await this.source.claudeTranscripts();
    } catch (error) {
      return unavailable("claude", `Could not list Claude transcripts: ${describe(error)}`);
    }
    const fresh = files.filter((file) => file.modifiedAt >= windowStartedAt);
    const rows: ClaudeUsageRow[] = [];
    let truncated = 0;
    for (const file of fresh) {
      let tail: LimitsTail;
      try {
        tail = await this.source.readTail(file.path, this.claudeTailBytes);
      } catch {
        continue;
      }
      if (tail.truncated) truncated += 1;
      rows.push(
        ...parseClaudeUsageLines(tail.text.split("\n"), {
          profile: file.profile,
          since: windowStartedAt,
          until: at,
        }),
      );
    }
    const usage = summarizeClaudeUsage(rows, windowStartedAt);
    const used = budgetPercent(usage.totalTokens, this.claudeTokenBudget);
    const notes = [
      "Indicative only: summed from local Claude Code transcripts, not from an Anthropic quota endpoint.",
      `Scanned ${fresh.length} of ${files.length} transcript file(s) touched inside the window.`,
    ];
    if (truncated > 0) {
      notes.push(
        `${truncated} transcript file(s) exceeded the ${this.claudeTailBytes}-byte tail budget, so this total is a floor.`,
      );
    }
    if (used === null) {
      notes.push(
        "usedPercent needs a calibrated denominator; pass --claude-budget TOKENS or set T3CHIEF_CLAUDE_TOKEN_BUDGET.",
      );
    }
    return {
      provider: "claude",
      windows: [
        {
          label: windowLabel(this.claudeWindowMinutes),
          usedPercent: used,
          resetsAt: null,
        },
      ],
      source: "estimate",
      observedAt: at,
      notes,
      usage,
    };
  }

  private async grok(at: string): Promise<ProviderLimits[]> {
    const probed = await this.probes.grok?.read({ at });
    if (probed && probed.length > 0) return probed;
    return unavailableList(
      "grok",
      "Grok exposes no local quota artifact on this host; headroom is unknown, not zero.",
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailableList(provider: string, note: string): ProviderLimits[] {
  return [unavailable(provider, note)];
}

function unavailable(provider: string, note: string): ProviderLimits {
  return {
    provider,
    windows: [],
    source: "unknown",
    observedAt: null,
    notes: [note],
  };
}
