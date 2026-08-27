import type { ScheduleLedger } from "../adapters/ledger.ts";
import type { ModelSelection, ProviderCatalog } from "../adapters/t3-v1.ts";
import { parseSessionLimitReset, type RateLimitSignalRecord } from "../domain/maintenance.ts";

const TERMINAL_TURN_STATES = new Set(["completed", "error", "interrupted"]);
const BUSY_TURN_STATES = new Set(["running", "starting", "queued", "pending"]);
const RATE_LIMIT_GRACE_MS = 2 * 60 * 1_000;
const RATE_LIMIT_MAX_OBSERVATION_AGE_MS = 12 * 60 * 60 * 1_000;
const RATE_LIMIT_MAX_OVERDUE_MS = 12 * 60 * 60 * 1_000;

interface TurnShell {
  turnId?: string;
  state?: string;
  requestedAt?: string;
  completedAt?: string;
}

interface ThreadShell {
  id: string;
  projectId?: string;
  title?: string;
  modelSelection?: ModelSelection;
  runtimeMode?: string;
  interactionMode?: string;
  latestTurn?: TurnShell | null;
  session?: { status?: string; lastError?: unknown } | null;
  settledOverride?: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
  latestUserMessageAt?: string | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
}

interface ThreadMessage {
  id?: string;
  role?: string;
  text?: string;
  createdAt?: string;
}

interface ThreadDetail {
  thread?: ThreadShell & { messages?: ThreadMessage[] };
}

interface ShellSnapshot {
  threads: ThreadShell[];
}

export interface MaintenanceT3Port {
  catalog(): Promise<ProviderCatalog>;
  shell(): Promise<unknown>;
  thread(threadId: string, options?: { turnLimit?: number }): Promise<unknown>;
  dispatch(command: Record<string, unknown>): Promise<unknown>;
}

type EnvironmentResolver = (environment: string) => Promise<MaintenanceT3Port>;

function shellSnapshot(value: unknown): ShellSnapshot {
  const record = value as Partial<ShellSnapshot>;
  return { threads: Array.isArray(record.threads) ? record.threads : [] };
}

function activeUnsettled(thread: ThreadShell): boolean {
  return !thread.archivedAt && !thread.deletedAt && thread.settledOverride !== "settled";
}

function busy(thread: ThreadShell): boolean {
  return (
    thread.hasPendingApprovals === true ||
    thread.hasPendingUserInput === true ||
    BUSY_TURN_STATES.has(thread.latestTurn?.state ?? "") ||
    ["running", "starting"].includes(thread.session?.status ?? "")
  );
}

function latestMessage(messages: ThreadMessage[]): ThreadMessage | null {
  return (
    messages
      .toSorted((left, right) => {
        const byTime = Date.parse(left.createdAt ?? "") - Date.parse(right.createdAt ?? "");
        return byTime || String(left.id ?? "").localeCompare(String(right.id ?? ""));
      })
      .at(-1) ?? null
  );
}

function hasMessage(detail: ThreadDetail, messageId: string): boolean {
  return detail.thread?.messages?.some((message) => message.id === messageId) === true;
}

function notFound(error: unknown): boolean {
  return /(?:404|not found)/i.test(error instanceof Error ? error.message : String(error));
}

export interface RateLimitTickReport {
  apply: boolean;
  at: string;
  candidates: number;
  watching: string[];
  woke: string[];
  busy: string[];
  gone: string[];
  ignoredLate: string[];
  superseded: string[];
  expired: string[];
  errors: Array<{ threadId: string; error: string }>;
}

export class RateLimitManager {
  constructor(
    private readonly ledger: ScheduleLedger,
    private readonly resolveEnvironment: EnvironmentResolver,
  ) {}

  async tick(input: {
    environment: string;
    now?: string;
    apply: boolean;
  }): Promise<RateLimitTickReport> {
    const now = new Date(input.now ?? Date.now()).toISOString();
    const nowMs = Date.parse(now);
    const report: RateLimitTickReport = {
      apply: input.apply,
      at: now,
      candidates: 0,
      watching: [],
      woke: [],
      busy: [],
      gone: [],
      ignoredLate: [],
      superseded: [],
      expired: [],
      errors: [],
    };
    const t3 = await this.resolveEnvironment(input.environment);
    const snapshot = shellSnapshot(await t3.shell());
    const shells = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
    const details = new Map<string, ThreadDetail>();

    for (const thread of snapshot.threads) {
      if (
        !activeUnsettled(thread) ||
        !TERMINAL_TURN_STATES.has(thread.latestTurn?.state ?? "") ||
        busy(thread)
      ) {
        continue;
      }
      try {
        const detail = (await t3.thread(thread.id, { turnLimit: 1 })) as ThreadDetail;
        details.set(thread.id, detail);
        const message = latestMessage(detail.thread?.messages ?? []);
        if (
          message?.role !== "assistant" ||
          typeof message.id !== "string" ||
          typeof message.text !== "string" ||
          typeof message.createdAt !== "string"
        ) {
          continue;
        }
        const resetAt = parseSessionLimitReset(message.text, message.createdAt);
        if (!resetAt || nowMs - Date.parse(message.createdAt) > RATE_LIMIT_MAX_OBSERVATION_AGE_MS) {
          continue;
        }
        if (
          thread.latestUserMessageAt &&
          Date.parse(thread.latestUserMessageAt) > Date.parse(message.createdAt)
        ) {
          continue;
        }
        report.candidates += 1;
        const dueAt = new Date(Date.parse(resetAt) + RATE_LIMIT_GRACE_MS).toISOString();
        const status = nowMs < Date.parse(dueAt) ? "watching" : "ignored-late";
        const existing = this.ledger.getRateLimitSignal(input.environment, message.id);
        if (status === "watching") report.watching.push(thread.id);
        else if (!existing) report.ignoredLate.push(thread.id);
        if (input.apply && !existing) {
          this.ledger.observeRateLimitSignal({
            environment: input.environment,
            messageId: message.id,
            threadId: thread.id,
            title: thread.title ?? thread.id,
            messageAt: new Date(message.createdAt).toISOString(),
            resetAt,
            dueAt,
            observedAt: now,
            status,
          });
        }
      } catch (error) {
        report.errors.push({
          threadId: thread.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!input.apply) return report;

    const recoverable = this.ledger
      .listRateLimitSignals({ environment: input.environment })
      .filter((signal) => ["watching", "dispatching"].includes(signal.status));
    for (const signal of recoverable) {
      const thread = shells.get(signal.threadId);
      if (!thread) {
        this.ledger.markRateLimitSignal(input.environment, signal.messageId, "gone", {
          updatedAt: now,
          lastError: "Thread is no longer present in the active T3 shell.",
        });
        report.gone.push(signal.threadId);
        continue;
      }
      if (!activeUnsettled(thread)) {
        this.ledger.markRateLimitSignal(input.environment, signal.messageId, "superseded", {
          updatedAt: now,
          lastError: "The thread was settled or archived before its provider reset.",
        });
        report.superseded.push(signal.threadId);
        continue;
      }
      if (nowMs > Date.parse(signal.dueAt) + RATE_LIMIT_MAX_OVERDUE_MS) {
        this.ledger.markRateLimitSignal(input.environment, signal.messageId, "expired", {
          updatedAt: now,
          lastError: "The recovery window expired before delivery.",
        });
        report.expired.push(signal.threadId);
        continue;
      }

      let detail = details.get(signal.threadId);
      try {
        detail ??= (await t3.thread(signal.threadId, { turnLimit: 1 })) as ThreadDetail;
      } catch (error) {
        if (notFound(error)) {
          this.ledger.markRateLimitSignal(input.environment, signal.messageId, "gone", {
            updatedAt: now,
            lastError: "Thread detail was not found.",
          });
          report.gone.push(signal.threadId);
        } else {
          report.errors.push({
            threadId: signal.threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }

      if (hasMessage(detail, signal.continuationMessageId)) {
        this.ledger.markRateLimitSignal(input.environment, signal.messageId, "woke", {
          updatedAt: now,
          wokeAt: now,
          lastError: null,
        });
        continue;
      }
      if (latestMessage(detail.thread?.messages ?? [])?.id !== signal.messageId) {
        this.ledger.markRateLimitSignal(input.environment, signal.messageId, "superseded", {
          updatedAt: now,
          lastError: "A newer thread message superseded the session-limit signal.",
        });
        report.superseded.push(signal.threadId);
        continue;
      }
      if (nowMs < Date.parse(signal.dueAt)) continue;
      if (busy(thread) || !TERMINAL_TURN_STATES.has(thread.latestTurn?.state ?? "")) {
        report.busy.push(signal.threadId);
        continue;
      }
      if (!thread.runtimeMode || !thread.interactionMode) {
        report.errors.push({
          threadId: signal.threadId,
          error: "Thread routing modes are missing.",
        });
        continue;
      }
      await this.dispatchSignal(t3, thread, signal, now, report);
    }
    return report;
  }

  private async dispatchSignal(
    t3: MaintenanceT3Port,
    thread: ThreadShell,
    signal: RateLimitSignalRecord,
    now: string,
    report: RateLimitTickReport,
  ): Promise<void> {
    const dispatching = this.ledger.markRateLimitSignal(
      signal.environment,
      signal.messageId,
      "dispatching",
      {
        updatedAt: now,
        attemptCount: signal.attemptCount + 1,
        lastError: null,
      },
    );
    try {
      await t3.dispatch({
        type: "thread.turn.start",
        commandId: signal.commandId,
        threadId: signal.threadId,
        message: {
          messageId: signal.continuationMessageId,
          role: "user",
          text: "Continue.",
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: signal.dueAt,
      });
      const detail = (await t3.thread(signal.threadId, { turnLimit: 1 })) as ThreadDetail;
      if (hasMessage(detail, signal.continuationMessageId)) {
        this.ledger.markRateLimitSignal(signal.environment, signal.messageId, "woke", {
          updatedAt: now,
          attemptCount: dispatching.attemptCount,
          wokeAt: now,
          lastError: null,
        });
        report.woke.push(signal.threadId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ledger.markRateLimitSignal(signal.environment, signal.messageId, "dispatching", {
        updatedAt: now,
        attemptCount: dispatching.attemptCount,
        lastError: message,
      });
      report.errors.push({ threadId: signal.threadId, error: message });
    }
  }
}

export interface MaintenanceCaptureReport {
  windowId: string;
  environment: string;
  captured: number;
  threadIds: string[];
  reused: boolean;
}

export interface MaintenanceDeliveryReport {
  environment: string;
  windowId: string | null;
  waitingForStop: boolean;
  discoveredInStopWindow: string[];
  delivered: string[];
  pending: string[];
  superseded: string[];
  gone: string[];
  errors: Array<{ threadId: string; error: string }>;
}

export class MaintenanceManager {
  private readonly now: () => string;

  constructor(
    private readonly ledger: ScheduleLedger,
    private readonly resolveEnvironment: EnvironmentResolver,
    options: { now?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async capture(environment: string): Promise<MaintenanceCaptureReport> {
    const openedAt = new Date(this.now()).toISOString();
    const t3 = await this.resolveEnvironment(environment);
    const snapshot = shellSnapshot(await t3.shell());
    const turns = snapshot.threads.flatMap((thread) => {
      const turnId = thread.latestTurn?.turnId;
      if (
        !activeUnsettled(thread) ||
        !turnId ||
        !BUSY_TURN_STATES.has(thread.latestTurn?.state ?? "")
      ) {
        return [];
      }
      return [
        {
          threadId: thread.id,
          turnId,
          title: thread.title ?? thread.id,
          ...(thread.latestTurn?.requestedAt ? { requestedAt: thread.latestTurn.requestedAt } : {}),
        },
      ];
    });
    const active = this.ledger.getActiveMaintenanceWindow(environment);
    if (active?.status === "stopped") {
      throw new Error(
        `Maintenance window '${active.id}' is awaiting delivery; do not start another update.`,
      );
    }
    if (active && Date.parse(openedAt) - Date.parse(active.openedAt) > 10 * 60 * 1_000) {
      throw new Error(
        `Maintenance window '${active.id}' has remained open for more than 10 minutes; inspect it before retrying.`,
      );
    }
    const window = active ?? this.ledger.openMaintenanceWindow(environment, openedAt, turns);
    if (active) {
      for (const turn of turns) {
        this.ledger.addMaintenanceTurn(active.id, turn, openedAt);
      }
    }
    return {
      windowId: window.id,
      environment,
      captured: turns.length,
      threadIds: turns.map((turn) => turn.threadId),
      reused: active !== null,
    };
  }

  markStopped(environment: string, stoppedAt = this.now()) {
    const active = this.ledger.getActiveMaintenanceWindow(environment);
    if (active?.status === "stopped") return active;
    return this.ledger.markMaintenanceStopped(environment, new Date(stoppedAt).toISOString());
  }

  status(environment?: string): {
    windows: ReturnType<ScheduleLedger["listMaintenanceWindows"]>;
    turns: ReturnType<ScheduleLedger["listMaintenanceTurns"]>;
  } {
    const windows = this.ledger.listMaintenanceWindows(environment ? { environment } : {});
    return {
      windows,
      turns: windows.flatMap((window) => this.ledger.listMaintenanceTurns(window.id)),
    };
  }

  async deliver(environment: string, at = this.now()): Promise<MaintenanceDeliveryReport> {
    const now = new Date(at).toISOString();
    const window = this.ledger.getActiveMaintenanceWindow(environment);
    const report: MaintenanceDeliveryReport = {
      environment,
      windowId: window?.id ?? null,
      waitingForStop: window?.status === "open",
      discoveredInStopWindow: [],
      delivered: [],
      pending: [],
      superseded: [],
      gone: [],
      errors: [],
    };
    if (!window || window.status === "open") return report;
    if (!window.stoppedAt)
      throw new Error(`Stopped maintenance window '${window.id}' has no stop time.`);

    const t3 = await this.resolveEnvironment(environment);
    const snapshot = shellSnapshot(await t3.shell());
    const shells = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
    const openedMs = Date.parse(window.openedAt);
    const stoppedMs = Date.parse(window.stoppedAt);

    for (const thread of snapshot.threads) {
      const turn = thread.latestTurn;
      const requestedMs = Date.parse(turn?.requestedAt ?? "");
      const completedMs = Date.parse(turn?.completedAt ?? "");
      if (
        !activeUnsettled(thread) ||
        !turn?.turnId ||
        turn.state !== "interrupted" ||
        !Number.isFinite(requestedMs) ||
        requestedMs < openedMs ||
        requestedMs > stoppedMs ||
        (Number.isFinite(completedMs) && (completedMs < openedMs || completedMs > stoppedMs)) ||
        this.ledger.getMaintenanceTurn(window.id, thread.id)?.turnId === turn.turnId
      ) {
        continue;
      }
      this.ledger.addMaintenanceTurn(
        window.id,
        {
          threadId: thread.id,
          turnId: turn.turnId,
          title: thread.title ?? thread.id,
          ...(turn.requestedAt ? { requestedAt: turn.requestedAt } : {}),
        },
        now,
      );
      report.discoveredInStopWindow.push(thread.id);
    }

    for (const item of this.ledger.listMaintenanceTurns(window.id)) {
      if (["delivered", "superseded", "gone"].includes(item.status)) continue;
      const thread = shells.get(item.threadId);
      if (!thread) {
        this.ledger.markMaintenanceTurn(window.id, item.threadId, "gone", {
          updatedAt: now,
          lastError: "Thread is no longer present in the active T3 shell.",
        });
        report.gone.push(item.threadId);
        continue;
      }
      let detail: ThreadDetail;
      try {
        detail = (await t3.thread(item.threadId, { turnLimit: 1 })) as ThreadDetail;
      } catch (error) {
        if (notFound(error)) {
          this.ledger.markMaintenanceTurn(window.id, item.threadId, "gone", {
            updatedAt: now,
            lastError: "Thread detail was not found.",
          });
          report.gone.push(item.threadId);
        } else {
          report.errors.push({
            threadId: item.threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
      if (hasMessage(detail, item.messageId)) {
        this.ledger.markMaintenanceTurn(window.id, item.threadId, "delivered", {
          updatedAt: now,
          deliveredAt: now,
          lastError: null,
        });
        continue;
      }
      if (thread.latestTurn?.turnId !== item.turnId) {
        this.ledger.markMaintenanceTurn(window.id, item.threadId, "superseded", {
          updatedAt: now,
          lastError: "A newer turn replaced the captured maintenance turn.",
        });
        report.superseded.push(item.threadId);
        continue;
      }
      if (thread.latestTurn?.state !== "interrupted") {
        if (BUSY_TURN_STATES.has(thread.latestTurn?.state ?? "")) {
          report.pending.push(item.threadId);
          continue;
        }
        this.ledger.markMaintenanceTurn(window.id, item.threadId, "superseded", {
          updatedAt: now,
          lastError: "The captured turn completed or a newer turn replaced it.",
        });
        report.superseded.push(item.threadId);
        continue;
      }
      if (busy(thread) || !thread.runtimeMode || !thread.interactionMode) {
        report.pending.push(item.threadId);
        continue;
      }

      const dispatching = this.ledger.markMaintenanceTurn(window.id, item.threadId, "dispatching", {
        updatedAt: now,
        attemptCount: item.attemptCount + 1,
        lastError: null,
      });
      try {
        await t3.dispatch({
          type: "thread.turn.start",
          commandId: item.commandId,
          threadId: item.threadId,
          message: {
            messageId: item.messageId,
            role: "user",
            text: "Continue.",
            attachments: [],
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: item.capturedAt,
        });
        const verification = (await t3.thread(item.threadId, { turnLimit: 1 })) as ThreadDetail;
        if (hasMessage(verification, item.messageId)) {
          this.ledger.markMaintenanceTurn(window.id, item.threadId, "delivered", {
            updatedAt: now,
            attemptCount: dispatching.attemptCount,
            deliveredAt: now,
            lastError: null,
          });
          report.delivered.push(item.threadId);
        } else {
          report.pending.push(item.threadId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.ledger.markMaintenanceTurn(window.id, item.threadId, "dispatching", {
          updatedAt: now,
          attemptCount: dispatching.attemptCount,
          lastError: message,
        });
        report.errors.push({ threadId: item.threadId, error: message });
      }
    }

    const remaining = this.ledger
      .listMaintenanceTurns(window.id)
      .filter((item) => ["pending", "dispatching"].includes(item.status));
    if (remaining.length === 0) this.ledger.completeMaintenanceWindow(window.id, now);
    return report;
  }
}
