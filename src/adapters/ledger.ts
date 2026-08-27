import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  type MaintenanceTurnRecord,
  type MaintenanceTurnStatus,
  type MaintenanceWindowRecord,
  type MaintenanceWindowStatus,
  maintenanceDispatchIds,
  maintenanceWindowId,
  type RateLimitSignalRecord,
  type RateLimitSignalStatus,
  rateLimitDispatchIds,
} from "../domain/maintenance.ts";
import type {
  OccurrenceRecord,
  OccurrenceState,
  ScheduleRecord,
  ScheduleRequest,
} from "../domain/model.ts";
import { deterministicRunIds } from "../domain/schedule.ts";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeDiagnostic(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(access|refresh|subject)[_-]?token\b["']?\s*[:=]\s*["']?[^\s,"']+/gi,
      "$1_token=[redacted]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-token]")
    .replace(/\b(?:sk|xox[baprs]?|gh[pousr])-[A-Za-z0-9_-]{8,}\b/gi, "[redacted-token]")
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || "Unspecified error.").slice(0, 1_000);
}

function normalizeReceipt(value: unknown): Record<string, string | number | boolean> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const receipt: Record<string, string | number | boolean> = {};
  for (const key of ["commandId", "receiptId", "status"] as const) {
    const item = input[key];
    if (typeof item === "string" && /^[A-Za-z0-9._:/-]{1,256}$/.test(item)) receipt[key] = item;
  }
  if (typeof input.sequence === "number" && Number.isSafeInteger(input.sequence)) {
    receipt.sequence = input.sequence;
  }
  for (const key of ["accepted", "replayed"] as const) {
    if (typeof input[key] === "boolean") receipt[key] = input[key];
  }
  return Object.keys(receipt).length > 0 ? receipt : null;
}

function scheduleId(managerId: string, key: string): string {
  return `sch_${sha256(`t3chief-schedule/v1\0${managerId}\0${key}`).slice(0, 32)}`;
}

export class ScheduleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleConflictError";
  }
}

interface ScheduleRow {
  id: string;
  manager_id: string;
  schedule_key: string;
  revision: number;
  enabled: number;
  definition_json: string;
  definition_hash: string;
  prompt_sha256: string;
  created_at: string;
  updated_at: string;
  last_materialized_at: string;
  deleted_at: string | null;
}

interface OccurrenceRow {
  id: string;
  schedule_id: string;
  schedule_revision: number;
  run_key: string;
  scheduled_for: string;
  state: OccurrenceState;
  command_id: string;
  message_id: string;
  thread_id: string;
  schedule_json: string;
  resolved_model_json: string | null;
  attempt_count: number;
  receipt_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
}

interface RateLimitSignalRow {
  environment: string;
  message_id: string;
  thread_id: string;
  title: string;
  message_at: string;
  reset_at: string;
  due_at: string;
  status: RateLimitSignalStatus;
  command_id: string;
  continuation_message_id: string;
  attempt_count: number;
  detected_at: string;
  updated_at: string;
  woke_at: string | null;
  last_error: string | null;
}

interface MaintenanceWindowRow {
  id: string;
  environment: string;
  status: MaintenanceWindowStatus;
  opened_at: string;
  stopped_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface MaintenanceTurnRow {
  window_id: string;
  thread_id: string;
  turn_id: string;
  title: string;
  requested_at: string | null;
  captured_at: string;
  status: MaintenanceTurnStatus;
  command_id: string;
  message_id: string;
  attempt_count: number;
  updated_at: string;
  delivered_at: string | null;
  last_error: string | null;
}

function decodeSchedule(row: ScheduleRow): ScheduleRecord {
  const definition = JSON.parse(row.definition_json) as ScheduleRequest;
  return {
    ...definition,
    enabled: row.enabled === 1,
    id: row.id,
    revision: row.revision,
    definitionHash: row.definition_hash,
    promptSha256: row.prompt_sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMaterializedAt: row.last_materialized_at,
  };
}

function decodeOccurrence(row: OccurrenceRow): OccurrenceRecord {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    scheduleRevision: row.schedule_revision,
    runKey: row.run_key,
    scheduledFor: row.scheduled_for,
    state: row.state,
    commandId: row.command_id,
    messageId: row.message_id,
    threadId: row.thread_id,
    schedule: JSON.parse(row.schedule_json) as ScheduleRecord,
    resolvedModelSelection: row.resolved_model_json
      ? (JSON.parse(row.resolved_model_json) as OccurrenceRecord["resolvedModelSelection"])
      : null,
    attemptCount: row.attempt_count,
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    verifiedAt: row.verified_at,
  };
}

function decodeRateLimitSignal(row: RateLimitSignalRow): RateLimitSignalRecord {
  return {
    environment: row.environment,
    messageId: row.message_id,
    threadId: row.thread_id,
    title: row.title,
    messageAt: row.message_at,
    resetAt: row.reset_at,
    dueAt: row.due_at,
    status: row.status,
    commandId: row.command_id,
    continuationMessageId: row.continuation_message_id,
    attemptCount: row.attempt_count,
    detectedAt: row.detected_at,
    updatedAt: row.updated_at,
    wokeAt: row.woke_at,
    lastError: row.last_error,
  };
}

function decodeMaintenanceWindow(row: MaintenanceWindowRow): MaintenanceWindowRecord {
  return {
    id: row.id,
    environment: row.environment,
    status: row.status,
    openedAt: row.opened_at,
    stoppedAt: row.stopped_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function decodeMaintenanceTurn(row: MaintenanceTurnRow): MaintenanceTurnRecord {
  return {
    windowId: row.window_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    title: row.title,
    requestedAt: row.requested_at,
    capturedAt: row.captured_at,
    status: row.status,
    commandId: row.command_id,
    messageId: row.message_id,
    attemptCount: row.attempt_count,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
    lastError: row.last_error,
  };
}

export class ScheduleLedger implements Disposable {
  private readonly database: Database;
  private readonly now: () => string;

  constructor(path: string, options: { now?: () => string } = {}) {
    this.database = new Database(path, { create: true, strict: true });
    this.now = options.now ?? (() => new Date().toISOString());
    this.database.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.migrate();
  }

  [Symbol.dispose](): void {
    this.database.close(false);
  }

  close(): void {
    this.database.close(false);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        manager_id TEXT NOT NULL,
        schedule_key TEXT NOT NULL,
        revision INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        prompt_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_materialized_at TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE(manager_id, schedule_key)
      );
      CREATE TABLE IF NOT EXISTS occurrences (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        schedule_revision INTEGER NOT NULL,
        run_key TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        state TEXT NOT NULL,
        command_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        resolved_model_json TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        receipt_json TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        verified_at TEXT,
        UNIQUE(schedule_id, run_key)
      );
      CREATE INDEX IF NOT EXISTS occurrences_recovery
        ON occurrences(state, updated_at);
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        action TEXT NOT NULL,
        subject TEXT NOT NULL,
        detail_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rate_limit_signals (
        environment TEXT NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        title TEXT NOT NULL,
        message_at TEXT NOT NULL,
        reset_at TEXT NOT NULL,
        due_at TEXT NOT NULL,
        status TEXT NOT NULL,
        command_id TEXT NOT NULL,
        continuation_message_id TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        detected_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        woke_at TEXT,
        last_error TEXT,
        PRIMARY KEY(environment, message_id)
      );
      CREATE INDEX IF NOT EXISTS rate_limit_recovery
        ON rate_limit_signals(environment, status, due_at);
      CREATE TABLE IF NOT EXISTS maintenance_windows (
        id TEXT PRIMARY KEY,
        environment TEXT NOT NULL,
        status TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        stopped_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS maintenance_window_recovery
        ON maintenance_windows(environment, status, opened_at);
      CREATE TABLE IF NOT EXISTS maintenance_turns (
        window_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        title TEXT NOT NULL,
        requested_at TEXT,
        captured_at TEXT NOT NULL,
        status TEXT NOT NULL,
        command_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        delivered_at TEXT,
        last_error TEXT,
        PRIMARY KEY(window_id, thread_id),
        FOREIGN KEY(window_id) REFERENCES maintenance_windows(id)
      );
      CREATE TABLE IF NOT EXISTS provider_limit_cache (
        cache_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_endpoint_state (
        endpoint TEXT PRIMARY KEY,
        next_allowed_at TEXT NOT NULL,
        last_status TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }

  readProviderLimit(cacheKey: string, now: string): unknown | null {
    const row = this.database
      .query<{ payload_json: string }, [string, string]>(
        "SELECT payload_json FROM provider_limit_cache WHERE cache_key = ? AND expires_at > ?",
      )
      .get(cacheKey, now);
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json) as unknown;
    } catch {
      return null;
    }
  }

  writeProviderLimit(cacheKey: string, payload: unknown, observedAt: string, expiresAt: string) {
    this.database
      .query(
        `INSERT INTO provider_limit_cache(cache_key, payload_json, observed_at, expires_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           payload_json = excluded.payload_json,
           observed_at = excluded.observed_at,
           expires_at = excluded.expires_at`,
      )
      .run(cacheKey, JSON.stringify(payload), observedAt, expiresAt);
  }

  /**
   * Claim the next call slot for a remote endpoint. The reservation is written inside the same
   * immediate transaction that reads it, so parallel t3chief processes cannot both probe, and a
   * crash after the claim still leaves the cool-down in place.
   */
  reserveProviderEndpoint(endpoint: string, now: string, nextAllowedAt: string): boolean {
    return this.database
      .transaction(() => {
        const row = this.database
          .query<{ next_allowed_at: string }, [string]>(
            "SELECT next_allowed_at FROM provider_endpoint_state WHERE endpoint = ?",
          )
          .get(endpoint);
        if (row && row.next_allowed_at > now) return false;
        this.database
          .query(
            `INSERT INTO provider_endpoint_state(endpoint, next_allowed_at, last_status, updated_at)
             VALUES(?, ?, NULL, ?)
             ON CONFLICT(endpoint) DO UPDATE SET
               next_allowed_at = excluded.next_allowed_at,
               updated_at = excluded.updated_at`,
          )
          .run(endpoint, nextAllowedAt, now);
        return true;
      })
      .immediate();
  }

  backOffProviderEndpoint(endpoint: string, nextAllowedAt: string, status: string, now: string) {
    this.database
      .query(
        `INSERT INTO provider_endpoint_state(endpoint, next_allowed_at, last_status, updated_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           next_allowed_at = MAX(provider_endpoint_state.next_allowed_at, excluded.next_allowed_at),
           last_status = excluded.last_status,
           updated_at = excluded.updated_at`,
      )
      .run(endpoint, nextAllowedAt, status, now);
  }

  providerEndpointState(
    endpoint: string,
  ): { nextAllowedAt: string; lastStatus: string | null } | null {
    const row = this.database
      .query<{ next_allowed_at: string; last_status: string | null }, [string]>(
        "SELECT next_allowed_at, last_status FROM provider_endpoint_state WHERE endpoint = ?",
      )
      .get(endpoint);
    return row ? { nextAllowedAt: row.next_allowed_at, lastStatus: row.last_status } : null;
  }

  private scheduleRow(id: string): ScheduleRow | null {
    return (
      this.database.query<ScheduleRow, [string]>("SELECT * FROM schedules WHERE id = ?").get(id) ??
      null
    );
  }

  putSchedule(
    request: ScheduleRequest,
    options: { expectedRevision?: number } = {},
  ): ScheduleRecord {
    const id = scheduleId(request.managerId, request.key);
    const now = this.now();
    const definitionJson = canonical(request);
    const definitionHash = sha256(definitionJson);
    const promptSha256 = sha256(request.prompt);
    const existingRow = this.scheduleRow(id);
    if (existingRow) {
      if (existingRow.definition_hash === definitionHash && existingRow.deleted_at === null) {
        return decodeSchedule(existingRow);
      }
      if (options.expectedRevision === undefined) {
        throw new ScheduleConflictError(
          `Schedule '${request.managerId}/${request.key}' already exists with different content.`,
        );
      }
      if (existingRow.revision !== options.expectedRevision) {
        throw new ScheduleConflictError(
          `Schedule revision changed: expected ${options.expectedRevision}, found ${existingRow.revision}.`,
        );
      }
      this.database
        .query(
          `UPDATE schedules
           SET revision = ?, enabled = ?, definition_json = ?, definition_hash = ?,
               prompt_sha256 = ?, updated_at = ?, last_materialized_at = ?, deleted_at = NULL
           WHERE id = ?`,
        )
        .run(
          existingRow.revision + 1,
          request.enabled ? 1 : 0,
          definitionJson,
          definitionHash,
          promptSha256,
          now,
          now,
          id,
        );
    } else {
      this.database
        .query(
          `INSERT INTO schedules (
             id, manager_id, schedule_key, revision, enabled, definition_json,
             definition_hash, prompt_sha256, created_at, updated_at, last_materialized_at
           ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          request.managerId,
          request.key,
          request.enabled ? 1 : 0,
          definitionJson,
          definitionHash,
          promptSha256,
          now,
          now,
          now,
        );
    }
    const saved = this.scheduleRow(id);
    if (!saved) throw new Error(`Could not reload saved schedule '${id}'.`);
    this.audit("schedule.put", id, { revision: saved.revision, definitionHash });
    return decodeSchedule(saved);
  }

  getSchedule(idOrKey: string): ScheduleRecord | null {
    const row = this.database
      .query<ScheduleRow, [string, string]>(
        "SELECT * FROM schedules WHERE deleted_at IS NULL AND (id = ? OR schedule_key = ?)",
      )
      .get(idOrKey, idOrKey);
    return row ? decodeSchedule(row) : null;
  }

  listSchedules(options: { includeDisabled?: boolean } = {}): ScheduleRecord[] {
    const rows = this.database
      .query<ScheduleRow, []>(
        `SELECT * FROM schedules
         WHERE deleted_at IS NULL ${options.includeDisabled ? "" : "AND enabled = 1"}
         ORDER BY schedule_key`,
      )
      .all();
    return rows.map(decodeSchedule);
  }

  setScheduleEnabled(idOrKey: string, enabled: boolean): ScheduleRecord {
    const schedule = this.getSchedule(idOrKey);
    if (!schedule) throw new Error(`Schedule '${idOrKey}' was not found.`);
    const now = this.now();
    this.database
      .query(
        "UPDATE schedules SET enabled = ?, updated_at = ?, last_materialized_at = ? WHERE id = ?",
      )
      .run(enabled ? 1 : 0, now, now, schedule.id);
    this.audit(enabled ? "schedule.resume" : "schedule.pause", schedule.id, {});
    const saved = this.getSchedule(schedule.id);
    if (!saved) throw new Error(`Could not reload schedule '${schedule.id}'.`);
    return saved;
  }

  setLastMaterializedAt(id: string, instant: string): void {
    this.database
      .query("UPDATE schedules SET last_materialized_at = ?, updated_at = ? WHERE id = ?")
      .run(instant, this.now(), id);
  }

  removeSchedule(idOrKey: string): void {
    const schedule = this.getSchedule(idOrKey);
    if (!schedule) throw new Error(`Schedule '${idOrKey}' was not found.`);
    const now = this.now();
    this.database
      .transaction(() => {
        this.database
          .query("UPDATE schedules SET enabled = 0, deleted_at = ?, updated_at = ? WHERE id = ?")
          .run(now, now, schedule.id);
        this.database
          .query(
            `UPDATE occurrences
             SET state = 'skipped', last_error = 'Schedule removed before delivery.', updated_at = ?
             WHERE schedule_id = ?
               AND state IN ('planned', 'dispatching', 'accepted', 'deferred', 'blocked')`,
          )
          .run(now, schedule.id);
        this.audit("schedule.remove", schedule.id, {});
      })
      .immediate();
  }

  reserveOccurrence(
    schedule: ScheduleRecord,
    input: { runKey: string; scheduledFor: string },
  ): OccurrenceRecord {
    const ids = deterministicRunIds(schedule.id, input.runKey);
    const now = this.now();
    const threadId =
      schedule.target.kind === "existing-thread" ? schedule.target.threadId : ids.threadId;
    this.database
      .query(
        `INSERT OR IGNORE INTO occurrences (
           id, schedule_id, schedule_revision, run_key, scheduled_for, state,
           command_id, message_id, thread_id, schedule_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ids.occurrenceId,
        schedule.id,
        schedule.revision,
        input.runKey,
        input.scheduledFor,
        ids.commandId,
        ids.messageId,
        threadId,
        canonical(schedule),
        now,
        now,
      );
    const occurrence = this.getOccurrence(ids.occurrenceId);
    if (!occurrence) throw new Error(`Could not reserve occurrence '${ids.occurrenceId}'.`);
    this.audit("occurrence.reserve", occurrence.id, {
      scheduleId: schedule.id,
      scheduledFor: input.scheduledFor,
    });
    return occurrence;
  }

  getOccurrence(id: string): OccurrenceRecord | null {
    const row = this.database
      .query<OccurrenceRow, [string]>("SELECT * FROM occurrences WHERE id = ?")
      .get(id);
    return row ? decodeOccurrence(row) : null;
  }

  listOccurrences(options: { scheduleId?: string } = {}): OccurrenceRecord[] {
    const rows = options.scheduleId
      ? this.database
          .query<OccurrenceRow, [string]>(
            "SELECT * FROM occurrences WHERE schedule_id = ? ORDER BY scheduled_for DESC",
          )
          .all(options.scheduleId)
      : this.database
          .query<OccurrenceRow, []>("SELECT * FROM occurrences ORDER BY scheduled_for DESC")
          .all();
    return rows.map(decodeOccurrence);
  }

  listRecoverableOccurrences(): OccurrenceRecord[] {
    return this.database
      .query<OccurrenceRow, []>(
        `SELECT * FROM occurrences
         WHERE state IN ('planned', 'dispatching', 'accepted', 'deferred', 'blocked')
         ORDER BY scheduled_for, id`,
      )
      .all()
      .map(decodeOccurrence);
  }

  hasUnresolvedOccurrence(scheduleIdValue: string): boolean {
    const row = this.database
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count FROM occurrences
         WHERE schedule_id = ? AND state IN ('planned', 'dispatching', 'accepted', 'deferred', 'blocked')`,
      )
      .get(scheduleIdValue);
    return (row?.count ?? 0) > 0;
  }

  markOccurrence(
    id: string,
    state: OccurrenceState,
    patch: {
      attemptCount?: number;
      resolvedModelSelection?: OccurrenceRecord["resolvedModelSelection"];
      receipt?: unknown;
      lastError?: string | null;
      threadId?: string;
    } = {},
  ): OccurrenceRecord {
    const current = this.getOccurrence(id);
    if (!current) throw new Error(`Occurrence '${id}' was not found.`);
    const now = this.now();
    const resolvedModel =
      patch.resolvedModelSelection === undefined
        ? current.resolvedModelSelection
        : patch.resolvedModelSelection;
    const receipt = normalizeReceipt(patch.receipt === undefined ? current.receipt : patch.receipt);
    const lastError = normalizeDiagnostic(
      patch.lastError === undefined ? current.lastError : patch.lastError,
    );
    this.database
      .query(
        `UPDATE occurrences
         SET state = ?, attempt_count = ?, resolved_model_json = ?, receipt_json = ?,
             last_error = ?, thread_id = ?, updated_at = ?, verified_at = ?
         WHERE id = ?`,
      )
      .run(
        state,
        patch.attemptCount ?? current.attemptCount,
        resolvedModel ? canonical(resolvedModel) : null,
        receipt === null ? null : canonical(receipt),
        lastError,
        patch.threadId ?? current.threadId,
        now,
        state === "verified" ? now : current.verifiedAt,
        id,
      );
    this.audit(`occurrence.${state}`, id, {
      attemptCount: patch.attemptCount ?? current.attemptCount,
    });
    const saved = this.getOccurrence(id);
    if (!saved) throw new Error(`Could not reload occurrence '${id}'.`);
    return saved;
  }

  observeRateLimitSignal(input: {
    environment: string;
    messageId: string;
    threadId: string;
    title: string;
    messageAt: string;
    resetAt: string;
    dueAt: string;
    observedAt: string;
    status: "watching" | "ignored-late";
  }): RateLimitSignalRecord {
    const ids = rateLimitDispatchIds(input.environment, input.messageId);
    this.database
      .query(
        `INSERT OR IGNORE INTO rate_limit_signals (
           environment, message_id, thread_id, title, message_at, reset_at, due_at,
           status, command_id, continuation_message_id, detected_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.environment,
        input.messageId,
        input.threadId,
        input.title,
        input.messageAt,
        input.resetAt,
        input.dueAt,
        input.status,
        ids.commandId,
        ids.messageId,
        input.observedAt,
        input.observedAt,
      );
    const saved = this.getRateLimitSignal(input.environment, input.messageId);
    if (!saved) throw new Error(`Could not save rate-limit signal '${input.messageId}'.`);
    this.audit("rate-limit.observe", `${input.environment}/${input.messageId}`, {
      status: saved.status,
      dueAt: saved.dueAt,
    });
    return saved;
  }

  getRateLimitSignal(environment: string, messageId: string): RateLimitSignalRecord | null {
    const row = this.database
      .query<RateLimitSignalRow, [string, string]>(
        "SELECT * FROM rate_limit_signals WHERE environment = ? AND message_id = ?",
      )
      .get(environment, messageId);
    return row ? decodeRateLimitSignal(row) : null;
  }

  listRateLimitSignals(options: { environment?: string } = {}): RateLimitSignalRecord[] {
    const rows = options.environment
      ? this.database
          .query<RateLimitSignalRow, [string]>(
            "SELECT * FROM rate_limit_signals WHERE environment = ? ORDER BY detected_at DESC",
          )
          .all(options.environment)
      : this.database
          .query<RateLimitSignalRow, []>(
            "SELECT * FROM rate_limit_signals ORDER BY detected_at DESC",
          )
          .all();
    return rows.map(decodeRateLimitSignal);
  }

  markRateLimitSignal(
    environment: string,
    messageId: string,
    status: RateLimitSignalStatus,
    patch: {
      updatedAt: string;
      attemptCount?: number;
      lastError?: string | null;
      wokeAt?: string | null;
    },
  ): RateLimitSignalRecord {
    const current = this.getRateLimitSignal(environment, messageId);
    if (!current) throw new Error(`Rate-limit signal '${environment}/${messageId}' was not found.`);
    this.database
      .query(
        `UPDATE rate_limit_signals
         SET status = ?, attempt_count = ?, updated_at = ?, woke_at = ?, last_error = ?
         WHERE environment = ? AND message_id = ?`,
      )
      .run(
        status,
        patch.attemptCount ?? current.attemptCount,
        patch.updatedAt,
        patch.wokeAt === undefined ? current.wokeAt : patch.wokeAt,
        normalizeDiagnostic(patch.lastError === undefined ? current.lastError : patch.lastError),
        environment,
        messageId,
      );
    this.audit(`rate-limit.${status}`, `${environment}/${messageId}`, {
      attemptCount: patch.attemptCount ?? current.attemptCount,
    });
    const saved = this.getRateLimitSignal(environment, messageId);
    if (!saved) throw new Error(`Could not reload rate-limit signal '${messageId}'.`);
    return saved;
  }

  openMaintenanceWindow(
    environment: string,
    openedAt: string,
    turns: Array<{
      threadId: string;
      turnId: string;
      title: string;
      requestedAt?: string;
    }>,
  ): MaintenanceWindowRecord {
    const active = this.getActiveMaintenanceWindow(environment);
    if (active) {
      throw new Error(
        `Maintenance window '${active.id}' is still '${active.status}'; deliver or inspect it first.`,
      );
    }
    const id = maintenanceWindowId(environment, openedAt);
    this.database
      .transaction(() => {
        this.database
          .query(
            `INSERT INTO maintenance_windows (
               id, environment, status, opened_at, updated_at
             ) VALUES (?, ?, 'open', ?, ?)`,
          )
          .run(id, environment, openedAt, openedAt);
        for (const turn of turns) {
          this.insertMaintenanceTurn(id, turn, openedAt);
        }
        this.audit("maintenance.open", id, { environment, captured: turns.length });
      })
      .immediate();
    const saved = this.getMaintenanceWindow(id);
    if (!saved) throw new Error(`Could not reload maintenance window '${id}'.`);
    return saved;
  }

  getMaintenanceWindow(id: string): MaintenanceWindowRecord | null {
    const row = this.database
      .query<MaintenanceWindowRow, [string]>("SELECT * FROM maintenance_windows WHERE id = ?")
      .get(id);
    return row ? decodeMaintenanceWindow(row) : null;
  }

  getActiveMaintenanceWindow(environment: string): MaintenanceWindowRecord | null {
    const row = this.database
      .query<MaintenanceWindowRow, [string]>(
        `SELECT * FROM maintenance_windows
         WHERE environment = ? AND status IN ('open', 'stopped')
         ORDER BY opened_at DESC LIMIT 1`,
      )
      .get(environment);
    return row ? decodeMaintenanceWindow(row) : null;
  }

  listMaintenanceWindows(options: { environment?: string } = {}): MaintenanceWindowRecord[] {
    const rows = options.environment
      ? this.database
          .query<MaintenanceWindowRow, [string]>(
            "SELECT * FROM maintenance_windows WHERE environment = ? ORDER BY opened_at DESC",
          )
          .all(options.environment)
      : this.database
          .query<MaintenanceWindowRow, []>(
            "SELECT * FROM maintenance_windows ORDER BY opened_at DESC",
          )
          .all();
    return rows.map(decodeMaintenanceWindow);
  }

  markMaintenanceStopped(environment: string, stoppedAt: string): MaintenanceWindowRecord {
    const window = this.getActiveMaintenanceWindow(environment);
    if (window?.status !== "open") {
      throw new Error(`No open maintenance window exists for '${environment}'.`);
    }
    this.database
      .query(
        `UPDATE maintenance_windows
         SET status = 'stopped', stopped_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(stoppedAt, stoppedAt, window.id);
    this.audit("maintenance.stopped", window.id, { stoppedAt });
    const saved = this.getMaintenanceWindow(window.id);
    if (!saved) throw new Error(`Could not reload maintenance window '${window.id}'.`);
    return saved;
  }

  addMaintenanceTurn(
    windowId: string,
    turn: {
      threadId: string;
      turnId: string;
      title: string;
      requestedAt?: string;
    },
    capturedAt: string,
  ): MaintenanceTurnRecord {
    const current = this.getMaintenanceTurn(windowId, turn.threadId);
    if (current && current.turnId !== turn.turnId && current.status === "pending") {
      const ids = maintenanceDispatchIds(windowId, turn.threadId, turn.turnId);
      this.database
        .query(
          `UPDATE maintenance_turns
           SET turn_id = ?, title = ?, requested_at = ?, captured_at = ?, command_id = ?,
               message_id = ?, attempt_count = 0, updated_at = ?, delivered_at = NULL,
               last_error = NULL
           WHERE window_id = ? AND thread_id = ? AND status = 'pending'`,
        )
        .run(
          turn.turnId,
          turn.title,
          turn.requestedAt ?? null,
          capturedAt,
          ids.commandId,
          ids.messageId,
          capturedAt,
          windowId,
          turn.threadId,
        );
    } else {
      this.insertMaintenanceTurn(windowId, turn, capturedAt);
    }
    const saved = this.getMaintenanceTurn(windowId, turn.threadId);
    if (!saved) throw new Error(`Could not save maintenance turn '${turn.threadId}'.`);
    this.audit("maintenance.turn.capture", `${windowId}/${turn.threadId}`, {
      turnId: turn.turnId,
    });
    return saved;
  }

  private insertMaintenanceTurn(
    windowId: string,
    turn: {
      threadId: string;
      turnId: string;
      title: string;
      requestedAt?: string;
    },
    capturedAt: string,
  ): void {
    const ids = maintenanceDispatchIds(windowId, turn.threadId, turn.turnId);
    this.database
      .query(
        `INSERT OR IGNORE INTO maintenance_turns (
           window_id, thread_id, turn_id, title, requested_at, captured_at,
           status, command_id, message_id, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        windowId,
        turn.threadId,
        turn.turnId,
        turn.title,
        turn.requestedAt ?? null,
        capturedAt,
        ids.commandId,
        ids.messageId,
        capturedAt,
      );
  }

  getMaintenanceTurn(windowId: string, threadId: string): MaintenanceTurnRecord | null {
    const row = this.database
      .query<MaintenanceTurnRow, [string, string]>(
        "SELECT * FROM maintenance_turns WHERE window_id = ? AND thread_id = ?",
      )
      .get(windowId, threadId);
    return row ? decodeMaintenanceTurn(row) : null;
  }

  listMaintenanceTurns(windowId: string): MaintenanceTurnRecord[] {
    return this.database
      .query<MaintenanceTurnRow, [string]>(
        "SELECT * FROM maintenance_turns WHERE window_id = ? ORDER BY thread_id",
      )
      .all(windowId)
      .map(decodeMaintenanceTurn);
  }

  markMaintenanceTurn(
    windowId: string,
    threadId: string,
    status: MaintenanceTurnStatus,
    patch: {
      updatedAt: string;
      attemptCount?: number;
      deliveredAt?: string | null;
      lastError?: string | null;
    },
  ): MaintenanceTurnRecord {
    const current = this.getMaintenanceTurn(windowId, threadId);
    if (!current) throw new Error(`Maintenance turn '${windowId}/${threadId}' was not found.`);
    this.database
      .query(
        `UPDATE maintenance_turns
         SET status = ?, attempt_count = ?, updated_at = ?, delivered_at = ?, last_error = ?
         WHERE window_id = ? AND thread_id = ?`,
      )
      .run(
        status,
        patch.attemptCount ?? current.attemptCount,
        patch.updatedAt,
        patch.deliveredAt === undefined ? current.deliveredAt : patch.deliveredAt,
        normalizeDiagnostic(patch.lastError === undefined ? current.lastError : patch.lastError),
        windowId,
        threadId,
      );
    this.audit(`maintenance.turn.${status}`, `${windowId}/${threadId}`, {
      attemptCount: patch.attemptCount ?? current.attemptCount,
    });
    const saved = this.getMaintenanceTurn(windowId, threadId);
    if (!saved) throw new Error(`Could not reload maintenance turn '${threadId}'.`);
    return saved;
  }

  completeMaintenanceWindow(id: string, completedAt: string): MaintenanceWindowRecord {
    const window = this.getMaintenanceWindow(id);
    if (!window) throw new Error(`Maintenance window '${id}' was not found.`);
    this.database
      .query(
        `UPDATE maintenance_windows
         SET status = 'complete', completed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(completedAt, completedAt, id);
    this.audit("maintenance.complete", id, { completedAt });
    const saved = this.getMaintenanceWindow(id);
    if (!saved) throw new Error(`Could not reload maintenance window '${id}'.`);
    return saved;
  }

  private audit(action: string, subject: string, detail: unknown): void {
    this.database
      .query(
        "INSERT INTO audit_log (occurred_at, action, subject, detail_json) VALUES (?, ?, ?, ?)",
      )
      .run(this.now(), action, subject, canonical(detail));
  }
}
