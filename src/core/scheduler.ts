import type { ScheduleLedger } from "../adapters/ledger.ts";
import {
  type ModelSelection,
  type ProviderCatalog,
  validateModelSelection,
} from "../adapters/t3-v1.ts";
import type { OccurrenceRecord, ScheduleRecord, ScheduleRequest } from "../domain/model.ts";
import { dueInstants, triggerExpired, validateTrigger } from "../domain/schedule.ts";

export interface SchedulerT3Port {
  catalog(): Promise<ProviderCatalog>;
  shell(): Promise<unknown>;
  thread(threadId: string, options?: { turnLimit?: number }): Promise<unknown>;
  dispatch(command: Record<string, unknown>): Promise<unknown>;
}

type EnvironmentResolver = (environment: string) => Promise<SchedulerT3Port>;

interface ProjectShell {
  id: string;
  title?: string;
  workspaceRoot: string;
}

interface ThreadShell {
  id: string;
  projectId: string;
  modelSelection?: ModelSelection;
  runtimeMode?: string;
  interactionMode?: string;
  latestTurn?: { state?: string } | null;
  session?: { status?: string } | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
}

interface ShellSnapshot {
  projects: ProjectShell[];
  threads: ThreadShell[];
}

function parseShell(value: unknown): ShellSnapshot {
  const record = value as Partial<ShellSnapshot>;
  return {
    projects: Array.isArray(record.projects) ? record.projects : [],
    threads: Array.isArray(record.threads) ? record.threads : [],
  };
}

function busy(thread: ThreadShell): boolean {
  return (
    thread.hasPendingApprovals === true ||
    thread.hasPendingUserInput === true ||
    ["running", "starting", "queued", "pending"].includes(thread.latestTurn?.state ?? "") ||
    ["running", "starting"].includes(thread.session?.status ?? "")
  );
}

function scheduleError(request: ScheduleRequest): string | null {
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(request.key)) {
    return "Schedule key must contain 2-80 letters, numbers, dots, underscores, or hyphens.";
  }
  if (request.prompt.trim().length === 0) return "Schedule prompt cannot be empty.";
  if (request.prompt.length > 120_000)
    return "Schedule prompt exceeds T3's 120,000 character limit.";
  if (request.target.kind === "new-thread") {
    if (
      !["approval-required", "auto-accept-edits", "auto", "full-access"].includes(
        request.target.runtimeMode,
      )
    ) {
      return `Unsupported T3 runtime mode '${request.target.runtimeMode}'.`;
    }
    if (!["default", "plan"].includes(request.target.interactionMode)) {
      return `Unsupported T3 interaction mode '${request.target.interactionMode}'.`;
    }
    if (request.target.title.trim().length === 0) return "New thread title cannot be empty.";
    if (
      request.target.checkout.kind === "managed-worktree" &&
      request.target.checkout.baseBranch.trim().length === 0
    ) {
      return "Managed worktree base branch cannot be empty.";
    }
  }
  if (!["latest", "skip"].includes(request.policy.misfire)) {
    return `Unsupported misfire policy '${request.policy.misfire}'.`;
  }
  if (!["defer", "skip"].includes(request.policy.whenBusy)) {
    return `Unsupported busy-thread policy '${request.policy.whenBusy}'.`;
  }
  return validateTrigger(request.trigger);
}

export class ScheduleValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join(" "));
    this.name = "ScheduleValidationError";
  }
}

export interface TickPlan {
  scheduleId: string;
  runKey: string;
  scheduledFor: string;
}

export interface TickReport {
  apply: boolean;
  now: string;
  planned: TickPlan[];
  results: OccurrenceRecord[];
}

export class Scheduler {
  constructor(
    private readonly ledger: ScheduleLedger,
    private readonly resolveEnvironment: EnvironmentResolver,
  ) {}

  async validate(request: ScheduleRequest): Promise<void> {
    const issues: string[] = [];
    const localError = scheduleError(request);
    if (localError) issues.push(localError);
    let t3: SchedulerT3Port;
    try {
      t3 = await this.resolveEnvironment(request.environment);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
      throw new ScheduleValidationError(issues);
    }
    const shell = parseShell(await t3.shell());
    let selection: ModelSelection | undefined;
    if (request.target.kind === "existing-thread") {
      const target = request.target;
      const thread = shell.threads.find((candidate) => candidate.id === target.threadId);
      if (!thread) issues.push(`Thread '${target.threadId}' does not exist.`);
      selection = thread?.modelSelection;
      if (thread && !selection) issues.push(`Thread '${thread.id}' has no model selection.`);
    } else {
      const target = request.target;
      if (!shell.projects.some((project) => project.id === target.projectId)) {
        issues.push(`Project '${target.projectId}' does not exist.`);
      }
      selection = target.modelSelection;
    }
    if (selection) {
      const catalog = await t3.catalog();
      issues.push(...validateModelSelection(catalog, selection).map((issue) => issue.message));
    }
    if (issues.length > 0) throw new ScheduleValidationError(issues);
  }

  async put(
    request: ScheduleRequest,
    options: { expectedRevision?: number } = {},
  ): Promise<ScheduleRecord> {
    await this.validate(request);
    return this.ledger.putSchedule(request, options);
  }

  list(options: { includeDisabled?: boolean } = {}): ScheduleRecord[] {
    return this.ledger.listSchedules(options);
  }

  pause(idOrKey: string): ScheduleRecord {
    return this.ledger.setScheduleEnabled(idOrKey, false);
  }

  async resume(idOrKey: string): Promise<ScheduleRecord> {
    const schedule = this.ledger.getSchedule(idOrKey);
    if (!schedule) throw new Error(`Schedule '${idOrKey}' was not found.`);
    await this.validate(schedule);
    return this.ledger.setScheduleEnabled(schedule.id, true);
  }

  remove(idOrKey: string): void {
    this.ledger.removeSchedule(idOrKey);
  }

  async runNow(
    idOrKey: string,
    input: { requestId: string; now?: string; apply?: boolean },
  ): Promise<OccurrenceRecord | TickPlan> {
    const schedule = this.ledger.getSchedule(idOrKey);
    if (!schedule) throw new Error(`Schedule '${idOrKey}' was not found.`);
    const now = new Date(input.now ?? Date.now()).toISOString();
    const plan = {
      scheduleId: schedule.id,
      runKey: `manual:${input.requestId}`,
      scheduledFor: now,
    };
    if (input.apply === false) return plan;
    const occurrence = this.ledger.reserveOccurrence(schedule, plan);
    return this.deliver(occurrence);
  }

  async tick(input: { now?: string; apply: boolean }): Promise<TickReport> {
    const now = new Date(input.now ?? Date.now()).toISOString();
    const planned: TickPlan[] = [];
    for (const schedule of this.ledger.listSchedules()) {
      if (this.ledger.hasUnresolvedOccurrence(schedule.id)) continue;
      const instants = dueInstants({
        trigger: schedule.trigger,
        after: schedule.lastMaterializedAt,
        now,
        misfire: schedule.policy.misfire,
      });
      for (const scheduledFor of instants) {
        planned.push({ scheduleId: schedule.id, runKey: scheduledFor, scheduledFor });
      }
      if (input.apply && schedule.policy.misfire === "skip" && instants.length === 0) {
        this.ledger.setLastMaterializedAt(schedule.id, now);
      }
      // A cron schedule past its --until bound has nothing left to deliver; retire it so it
      // stops surfacing as active work. Unresolved occurrences were excluded above, so any
      // in-flight final run still recovers before this branch is reached.
      if (input.apply && instants.length === 0 && triggerExpired(schedule.trigger, now)) {
        this.ledger.setScheduleEnabled(schedule.id, false);
      }
    }
    if (!input.apply) return { apply: false, now, planned, results: [] };

    const newlyReserved: OccurrenceRecord[] = [];
    for (const plan of planned) {
      const schedule = this.ledger.getSchedule(plan.scheduleId);
      if (!schedule) continue;
      newlyReserved.push(this.ledger.reserveOccurrence(schedule, plan));
      this.ledger.setLastMaterializedAt(schedule.id, plan.scheduledFor);
    }

    const recoverable = this.ledger
      .listRecoverableOccurrences()
      .filter((occurrence) => this.ledger.getSchedule(occurrence.scheduleId)?.enabled === true);
    const selected = new Map<string, OccurrenceRecord>();
    for (const occurrence of [...recoverable, ...newlyReserved])
      selected.set(occurrence.id, occurrence);
    const results: OccurrenceRecord[] = [];
    for (const occurrence of selected.values()) {
      try {
        results.push(await this.deliver(occurrence));
      } catch (error) {
        results.push(
          this.ledger.markOccurrence(occurrence.id, "dispatching", {
            attemptCount: occurrence.attemptCount + 1,
            lastError: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    return { apply: true, now, planned, results };
  }

  private async deliver(occurrence: OccurrenceRecord): Promise<OccurrenceRecord> {
    if (["verified", "skipped", "failed"].includes(occurrence.state)) return occurrence;

    const schedule = occurrence.schedule;
    const t3 = await this.resolveEnvironment(schedule.environment);
    if (["dispatching", "accepted"].includes(occurrence.state)) {
      try {
        const detail = (await t3.thread(occurrence.threadId, { turnLimit: 50 })) as {
          thread?: { messages?: Array<{ id?: string }> };
        };
        if (detail.thread?.messages?.some((message) => message.id === occurrence.messageId)) {
          return this.ledger.markOccurrence(occurrence.id, "verified", { lastError: null });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/(?:404|not found)/i.test(message)) {
          return this.ledger.markOccurrence(occurrence.id, occurrence.state, {
            lastError: `Recovery verification unavailable: ${message}`,
          });
        }
      }
    }

    const shell = parseShell(await t3.shell());
    let selection: ModelSelection;
    let runtimeMode: string;
    let interactionMode: string;
    let project: ProjectShell | undefined;
    let thread: ThreadShell | undefined;

    if (schedule.target.kind === "existing-thread") {
      const target = schedule.target;
      thread = shell.threads.find((candidate) => candidate.id === target.threadId);
      if (!thread) {
        return this.ledger.markOccurrence(occurrence.id, "blocked", {
          lastError: `Thread '${target.threadId}' does not exist.`,
        });
      }
      if (!thread.modelSelection || !thread.runtimeMode || !thread.interactionMode) {
        return this.ledger.markOccurrence(occurrence.id, "blocked", {
          lastError: `Thread '${thread.id}' has incomplete routing metadata.`,
        });
      }
      selection = thread.modelSelection;
      runtimeMode = thread.runtimeMode;
      interactionMode = thread.interactionMode;
      if (busy(thread)) {
        return this.ledger.markOccurrence(
          occurrence.id,
          schedule.policy.whenBusy === "skip" ? "skipped" : "deferred",
          { lastError: "Target thread is busy." },
        );
      }
    } else {
      const target = schedule.target;
      project = shell.projects.find((candidate) => candidate.id === target.projectId);
      if (!project) {
        return this.ledger.markOccurrence(occurrence.id, "blocked", {
          lastError: `Project '${target.projectId}' does not exist.`,
        });
      }
      selection = target.modelSelection;
      runtimeMode = target.runtimeMode;
      interactionMode = target.interactionMode;
    }

    const catalog = await t3.catalog();
    const routeIssues = validateModelSelection(catalog, selection);
    if (routeIssues.length > 0) {
      return this.ledger.markOccurrence(occurrence.id, "blocked", {
        resolvedModelSelection: selection,
        lastError: routeIssues.map((issue) => issue.message).join(" "),
      });
    }

    const commandInput = {
      occurrence,
      selection,
      runtimeMode,
      interactionMode,
      ...(project ? { project } : {}),
    };
    const command = this.commandFor(commandInput);
    const dispatching = this.ledger.markOccurrence(occurrence.id, "dispatching", {
      resolvedModelSelection: selection,
      attemptCount: occurrence.attemptCount + 1,
      lastError: null,
    });
    let receipt: unknown;
    try {
      receipt = await t3.dispatch(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanentlyRejected =
        /(?:OrchestrationCommandPreviouslyRejectedError|Command previously rejected)/i.test(
          message,
        );
      return this.ledger.markOccurrence(
        occurrence.id,
        permanentlyRejected ? "failed" : "dispatching",
        {
          attemptCount: dispatching.attemptCount,
          lastError: message,
        },
      );
    }
    const accepted = this.ledger.markOccurrence(occurrence.id, "accepted", {
      attemptCount: dispatching.attemptCount,
      receipt,
      lastError: null,
    });
    try {
      const detail = (await t3.thread(accepted.threadId, { turnLimit: 10 })) as {
        thread?: { messages?: Array<{ id?: string }> };
      };
      const verified = detail.thread?.messages?.some(
        (message) => message.id === accepted.messageId,
      );
      return verified
        ? this.ledger.markOccurrence(accepted.id, "verified", { receipt, lastError: null })
        : accepted;
    } catch (error) {
      return this.ledger.markOccurrence(accepted.id, "accepted", {
        receipt,
        lastError: `Verification pending: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private commandFor(input: {
    occurrence: OccurrenceRecord;
    selection: ModelSelection;
    runtimeMode: string;
    interactionMode: string;
    project?: ProjectShell;
  }): Record<string, unknown> {
    const { occurrence, selection, runtimeMode, interactionMode } = input;
    const schedule = occurrence.schedule;
    const text = `[Scheduled by t3-chief: ${schedule.key}]\n\n${schedule.prompt}`;
    const base: Record<string, unknown> = {
      type: "thread.turn.start",
      commandId: occurrence.commandId,
      threadId: occurrence.threadId,
      message: {
        messageId: occurrence.messageId,
        role: "user",
        text,
        attachments: [],
      },
      modelSelection: selection,
      runtimeMode,
      interactionMode,
      createdAt: occurrence.createdAt,
    };
    if (schedule.target.kind === "existing-thread") return base;

    const checkout = schedule.target.checkout;
    const branch = checkout.kind === "managed-worktree" ? checkout.baseBranch : null;
    return {
      ...base,
      titleSeed: schedule.target.title,
      bootstrap: {
        createThread: {
          projectId: schedule.target.projectId,
          title: schedule.target.title,
          modelSelection: selection,
          runtimeMode,
          interactionMode,
          branch,
          worktreePath: null,
          createdAt: occurrence.createdAt,
        },
        ...(checkout.kind === "managed-worktree"
          ? {
              prepareWorktree: {
                projectCwd: input.project?.workspaceRoot,
                baseBranch: checkout.baseBranch,
                branch: `${checkout.branchPrefix ?? "t3chief"}/${schedule.key}-${occurrence.id.slice(-8)}`,
                ...(checkout.startFromOrigin ? { startFromOrigin: true } : {}),
              },
              runSetupScript: true,
            }
          : {}),
      },
    };
  }
}
