import {
  type ModelSelection,
  type ProviderCatalog,
  validateModelSelection,
} from "../adapters/t3-v1.ts";
import type { InteractionMode, RuntimeMode } from "../domain/model.ts";

export interface T3FleetPort {
  catalog(): Promise<ProviderCatalog>;
  shell(): Promise<unknown>;
  thread(
    threadId: string,
    options?: { turnLimit?: number; beforeCursor?: string },
  ): Promise<unknown>;
  dispatch(command: Record<string, unknown>): Promise<unknown>;
}

interface ProjectShell {
  id: string;
  title: string;
  workspaceRoot: string;
}

export interface ProjectSummary {
  id: string;
  title: string;
  workspaceRoot: string;
  threadCount: number;
}

export interface CreatedProject {
  projectId: string;
  title: string;
  workspaceRoot: string;
  createWorkspaceRootIfMissing: boolean;
  defaultModelSelection: ModelSelection | null;
  receipt: unknown;
}

export interface ProjectIconUpdate {
  projectId: string;
  title: string;
  faviconPath: string | null;
  receipt: unknown;
}

const PROJECT_ICON_EXTENSION = /\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i;
const MAX_PROJECT_ICON_PATH = 1024;

interface ThreadShell {
  id: string;
  projectId: string;
  title: string;
  modelSelection?: ModelSelection;
  runtimeMode?: string;
  interactionMode?: string;
  latestTurn?: { state?: string } | null;
  session?: { status?: string; lastError?: unknown } | null;
  settledOverride?: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
  snoozedUntil?: string | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  hasActionableProposedPlan?: boolean;
  backgroundLiveness?: unknown;
  updatedAt?: string;
}

interface ShellSnapshot {
  projects: ProjectShell[];
  threads: ThreadShell[];
}

export type ManagerThreadState =
  | "blocked-approval"
  | "blocked-input"
  | "running"
  | "queued"
  | "failed"
  | "review"
  | "idle"
  | "snoozed";

export interface ManagerThread {
  id: string;
  projectId: string;
  projectTitle: string;
  title: string;
  state: ManagerThreadState;
  modelSelection?: ModelSelection;
  runtimeMode?: string;
  interactionMode?: string;
  updatedAt?: string;
}

const STATE_ORDER: Record<ManagerThreadState, number> = {
  "blocked-approval": 0,
  "blocked-input": 1,
  failed: 2,
  running: 3,
  queued: 4,
  review: 5,
  idle: 6,
  snoozed: 7,
};

function shellSnapshot(value: unknown): ShellSnapshot {
  const record = value as Partial<ShellSnapshot>;
  return {
    projects: Array.isArray(record.projects) ? record.projects : [],
    threads: Array.isArray(record.threads) ? record.threads : [],
  };
}

function activeUnsettled(thread: ThreadShell): boolean {
  return !thread.archivedAt && !thread.deletedAt && thread.settledOverride !== "settled";
}

export function classifyThread(thread: ThreadShell): ManagerThreadState {
  if (thread.hasPendingApprovals) return "blocked-approval";
  if (thread.hasPendingUserInput) return "blocked-input";
  if (thread.snoozedUntil && Date.parse(thread.snoozedUntil) > Date.now()) return "snoozed";
  const turnState = thread.latestTurn?.state;
  if (turnState === "running" || turnState === "starting") return "running";
  if (turnState === "queued" || turnState === "pending") return "queued";
  if (turnState === "failed" || thread.session?.lastError) return "failed";
  if (turnState === "completed" || thread.hasActionableProposedPlan) return "review";
  return "idle";
}

function isSettleCandidate(thread: ThreadShell): boolean {
  const state = classifyThread(thread);
  return (
    (state === "review" || state === "idle") &&
    !thread.hasActionableProposedPlan &&
    !thread.backgroundLiveness &&
    thread.session?.status !== "running"
  );
}

export interface FleetManagerDependencies {
  uuid?: () => string;
  now?: () => string;
}

function normalizeRoot(path: string): string {
  return path.replace(/\/+$/, "");
}

export class FleetManager {
  private readonly uuid: () => string;
  private readonly now: () => string;

  constructor(
    private readonly t3: T3FleetPort,
    dependencies: FleetManagerDependencies = {},
  ) {
    this.uuid = dependencies.uuid ?? (() => crypto.randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  private async loadShell(): Promise<ShellSnapshot> {
    return shellSnapshot(await this.t3.shell());
  }

  async listProjects(): Promise<{ projects: ProjectSummary[] }> {
    const snapshot = await this.loadShell();
    const threadCounts = new Map<string, number>();
    for (const thread of snapshot.threads) {
      threadCounts.set(thread.projectId, (threadCounts.get(thread.projectId) ?? 0) + 1);
    }
    return {
      projects: snapshot.projects
        .map((project) => ({
          id: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          threadCount: threadCounts.get(project.id) ?? 0,
        }))
        .sort((left, right) => left.title.localeCompare(right.title)),
    };
  }

  /**
   * Register a workspace as a T3 project. T3 normalizes the workspace root itself, but an existing
   * project on the same root is rejected here so a caller never ends up with two IDs for one
   * directory and silently drives the wrong one.
   */
  async createProject(input: {
    title: string;
    workspaceRoot: string;
    createWorkspaceRootIfMissing?: boolean;
    defaultModelSelection?: ModelSelection;
  }): Promise<CreatedProject> {
    const title = input.title.trim();
    const workspaceRoot = input.workspaceRoot.trim();
    if (title.length === 0) throw new Error("Project title cannot be empty.");
    if (!workspaceRoot.startsWith("/")) {
      throw new Error("Project workspace root must be an absolute path.");
    }
    if (input.defaultModelSelection) {
      const issues = validateModelSelection(await this.t3.catalog(), input.defaultModelSelection);
      if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join(" "));
    }
    const snapshot = await this.loadShell();
    const existing = snapshot.projects.find(
      (project) => normalizeRoot(project.workspaceRoot) === normalizeRoot(workspaceRoot),
    );
    if (existing) {
      throw new Error(
        `Workspace '${workspaceRoot}' already belongs to project '${existing.id}' (${existing.title}).`,
      );
    }
    const projectId = this.uuid();
    const receipt = await this.t3.dispatch({
      type: "project.create",
      commandId: this.uuid(),
      projectId,
      title,
      workspaceRoot,
      createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing === true,
      ...(input.defaultModelSelection
        ? { defaultModelSelection: input.defaultModelSelection }
        : {}),
      createdAt: this.now(),
    });
    return {
      projectId,
      title,
      workspaceRoot,
      createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing === true,
      defaultModelSelection: input.defaultModelSelection ?? null,
      receipt,
    };
  }

  /**
   * Set (or clear) a project's icon. T3 accepts an absolute path or one relative to the workspace
   * root; only the extensions its asset layer can preview are allowed, so a bad path is rejected
   * here rather than silently rendering as a blank tile.
   */
  async setProjectIcon(input: {
    project: string;
    iconPath: string | null;
  }): Promise<ProjectIconUpdate> {
    const iconPath = input.iconPath === null ? null : input.iconPath.trim();
    if (iconPath !== null) {
      if (iconPath.length === 0) throw new Error("Project icon path cannot be empty.");
      if (iconPath.length > MAX_PROJECT_ICON_PATH) {
        throw new Error(`Project icon path must be at most ${MAX_PROJECT_ICON_PATH} characters.`);
      }
      if (!PROJECT_ICON_EXTENSION.test(iconPath)) {
        throw new Error(
          "Project icon must be an .avif, .gif, .ico, .jpg, .jpeg, .png, .svg, or .webp file.",
        );
      }
    }
    const snapshot = await this.loadShell();
    const project = this.resolveProject(snapshot, input.project);
    const receipt = await this.t3.dispatch({
      type: "project.meta.update",
      commandId: this.uuid(),
      projectId: project.id,
      faviconPath: iconPath,
    });
    return { projectId: project.id, title: project.title, faviconPath: iconPath, receipt };
  }

  private resolveProject(snapshot: ShellSnapshot, reference: string): ProjectShell {
    const exact = snapshot.projects.find((project) => project.id === reference);
    if (exact) return exact;
    const candidates = snapshot.projects.filter(
      (project) => project.id.startsWith(reference) || project.title === reference,
    );
    if (candidates.length === 1 && candidates[0]) return candidates[0];
    if (candidates.length > 1) throw new Error(`Project reference '${reference}' is ambiguous.`);
    throw new Error(`Project '${reference}' was not found.`);
  }

  private resolveThread(snapshot: ShellSnapshot, reference: string): ThreadShell {
    const exact = snapshot.threads.find((thread) => thread.id === reference);
    if (exact) return exact;
    const candidates = snapshot.threads.filter(
      (thread) => thread.id.startsWith(reference) || thread.title === reference,
    );
    if (candidates.length === 1 && candidates[0]) return candidates[0];
    if (candidates.length > 1) throw new Error(`Thread reference '${reference}' is ambiguous.`);
    throw new Error(`Thread '${reference}' was not found.`);
  }

  async status(options: { includeSettled?: boolean } = {}): Promise<{
    summary: Record<string, number>;
    threads: ManagerThread[];
  }> {
    const snapshot = await this.loadShell();
    const projectTitles = new Map(snapshot.projects.map((project) => [project.id, project.title]));
    const selected = options.includeSettled
      ? snapshot.threads.filter((thread) => !thread.archivedAt && !thread.deletedAt)
      : snapshot.threads.filter(activeUnsettled);
    const threads = selected
      .map((thread): ManagerThread => {
        const state = classifyThread(thread);
        return {
          id: thread.id,
          projectId: thread.projectId,
          projectTitle: projectTitles.get(thread.projectId) ?? thread.projectId,
          title: thread.title,
          state,
          ...(thread.modelSelection ? { modelSelection: thread.modelSelection } : {}),
          ...(thread.runtimeMode ? { runtimeMode: thread.runtimeMode } : {}),
          ...(thread.interactionMode ? { interactionMode: thread.interactionMode } : {}),
          ...(thread.updatedAt ? { updatedAt: thread.updatedAt } : {}),
        };
      })
      .sort(
        (left, right) =>
          STATE_ORDER[left.state] - STATE_ORDER[right.state] || left.id.localeCompare(right.id),
      );
    const summary: Record<string, number> = { total: threads.length };
    for (const thread of threads) {
      const key = thread.state.startsWith("blocked-") ? "blocked" : thread.state;
      summary[key] = (summary[key] ?? 0) + 1;
    }
    return { summary, threads };
  }

  async brief(
    reference: string,
    options: {
      turnLimit?: number;
      maxMessageCharacters?: number;
      maxTotalCharacters?: number;
    } = {},
  ): Promise<{
    thread: Record<string, unknown>;
    messages: Array<Record<string, unknown>>;
    page: unknown;
  }> {
    const requestedTurnLimit = options.turnLimit ?? 50;
    if (
      !Number.isInteger(requestedTurnLimit) ||
      requestedTurnLimit < 1 ||
      requestedTurnLimit > 150
    ) {
      throw new Error("Thread context turn limit must be an integer between 1 and 150.");
    }
    const snapshot = await this.loadShell();
    const shell = this.resolveThread(snapshot, reference);
    const detail = (await this.t3.thread(shell.id, { turnLimit: requestedTurnLimit })) as {
      thread?: Record<string, unknown> & { messages?: Array<Record<string, unknown>> };
      page?: unknown;
    };
    if (!detail.thread) throw new Error(`T3 returned no detail for thread '${shell.id}'.`);
    const maxMessage = options.maxMessageCharacters ?? 8_000;
    let remaining = options.maxTotalCharacters ?? 80_000;
    const messages = (detail.thread.messages ?? [])
      .toReversed()
      .flatMap((message) => {
        if (remaining <= 0) return [];
        const text = typeof message.text === "string" ? message.text : "";
        const kept = text.slice(0, Math.min(maxMessage, remaining));
        remaining -= kept.length;
        return [{ ...message, text: kept, truncated: kept.length < text.length }];
      })
      .toReversed();
    const { messages: _messages, ...thread } = detail.thread;
    return { thread, messages, page: detail.page ?? null };
  }

  async send(reference: string, text: string): Promise<unknown> {
    if (text.trim().length === 0) throw new Error("Follow-up text cannot be empty.");
    if (text.length > 120_000)
      throw new Error("Follow-up text exceeds T3's 120,000 character limit.");
    const snapshot = await this.loadShell();
    const thread = this.resolveThread(snapshot, reference);
    if (!thread.runtimeMode || !thread.interactionMode || !thread.modelSelection) {
      throw new Error(`Thread '${thread.id}' has incomplete routing metadata.`);
    }
    return this.t3.dispatch({
      type: "thread.turn.start",
      commandId: this.uuid(),
      threadId: thread.id,
      message: {
        messageId: this.uuid(),
        role: "user",
        text,
        attachments: [],
      },
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: this.now(),
    });
  }

  async start(input: {
    projectId: string;
    title: string;
    text: string;
    modelSelection: ModelSelection;
    runtimeMode: RuntimeMode;
    interactionMode: InteractionMode;
    checkout:
      | { kind: "project-workspace" }
      | { kind: "managed-worktree"; baseBranch: string; startFromOrigin?: boolean };
  }): Promise<unknown> {
    if (input.title.trim().length === 0) throw new Error("Thread title cannot be empty.");
    if (input.text.trim().length === 0) throw new Error("Initial message cannot be empty.");
    if (input.text.length > 120_000)
      throw new Error("Initial message exceeds T3's 120,000 character limit.");
    if (
      !["approval-required", "auto-accept-edits", "auto", "full-access"].includes(input.runtimeMode)
    ) {
      throw new Error(`Unsupported T3 runtime mode '${input.runtimeMode}'.`);
    }
    if (!["default", "plan"].includes(input.interactionMode)) {
      throw new Error(`Unsupported T3 interaction mode '${input.interactionMode}'.`);
    }
    if (
      input.checkout.kind === "managed-worktree" &&
      input.checkout.baseBranch.trim().length === 0
    ) {
      throw new Error("Managed worktree base branch cannot be empty.");
    }
    const routeIssues = validateModelSelection(await this.t3.catalog(), input.modelSelection);
    if (routeIssues.length > 0) {
      throw new Error(routeIssues.map((issue) => issue.message).join(" "));
    }
    const snapshot = await this.loadShell();
    const project = snapshot.projects.find((candidate) => candidate.id === input.projectId);
    if (!project) throw new Error(`Project '${input.projectId}' was not found.`);
    const threadId = this.uuid();
    const commandId = this.uuid();
    const messageId = this.uuid();
    const createdAt = this.now();
    const managedCheckout = input.checkout.kind === "managed-worktree" ? input.checkout : undefined;
    return this.t3.dispatch({
      type: "thread.turn.start",
      commandId,
      threadId,
      message: { messageId, role: "user", text: input.text, attachments: [] },
      modelSelection: input.modelSelection,
      titleSeed: input.title,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      bootstrap: {
        createThread: {
          projectId: project.id,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          branch: managedCheckout?.baseBranch ?? null,
          worktreePath: null,
          createdAt,
        },
        ...(managedCheckout
          ? {
              prepareWorktree: {
                projectCwd: project.workspaceRoot,
                baseBranch: managedCheckout.baseBranch,
                branch: `t3chief/${threadId.slice(0, 12)}`,
                ...(managedCheckout.startFromOrigin ? { startFromOrigin: true } : {}),
              },
              runSetupScript: true,
            }
          : {}),
      },
      createdAt,
    });
  }

  async setSettlement(reference: string, settled: boolean): Promise<unknown> {
    const snapshot = await this.loadShell();
    const thread = this.resolveThread(snapshot, reference);
    return this.t3.dispatch({
      type: settled ? "thread.settle" : "thread.unsettle",
      commandId: this.uuid(),
      threadId: thread.id,
      ...(!settled ? { reason: "user" } : {}),
    });
  }

  async interrupt(reference: string): Promise<unknown> {
    const snapshot = await this.loadShell();
    const thread = this.resolveThread(snapshot, reference);
    return this.t3.dispatch({
      type: "thread.turn.interrupt",
      commandId: this.uuid(),
      threadId: thread.id,
      createdAt: this.now(),
    });
  }

  async settleReady(options: { apply: boolean }): Promise<{
    operations: Array<{ type: "thread.settle"; threadId: string; commandId: string }>;
    applied: number;
  }> {
    const snapshot = await this.loadShell();
    const operations = snapshot.threads
      .filter(activeUnsettled)
      .filter(isSettleCandidate)
      .map((thread) => ({
        type: "thread.settle" as const,
        threadId: thread.id,
        commandId: this.uuid(),
      }));
    if (!options.apply) return { operations, applied: 0 };
    for (const operation of operations) await this.t3.dispatch(operation);
    return { operations, applied: operations.length };
  }
}
