import type { ModelSelection } from "../adapters/t3-v1.ts";
import type { Trigger } from "./schedule.ts";

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export type InteractionMode = "default" | "plan";

export type ScheduleTarget =
  | { kind: "existing-thread"; threadId: string }
  | {
      kind: "new-thread";
      projectId: string;
      title: string;
      modelSelection: ModelSelection;
      runtimeMode: RuntimeMode;
      interactionMode: InteractionMode;
      checkout:
        | { kind: "project-workspace" }
        | {
            kind: "managed-worktree";
            baseBranch: string;
            branchPrefix?: string;
            startFromOrigin?: boolean;
          };
    };

export interface ScheduleRequest {
  managerId: string;
  key: string;
  environment: string;
  trigger: Trigger;
  target: ScheduleTarget;
  prompt: string;
  enabled: boolean;
  policy: {
    misfire: "latest" | "skip";
    whenBusy: "defer" | "skip";
  };
}

export interface ScheduleRecord extends ScheduleRequest {
  id: string;
  revision: number;
  definitionHash: string;
  promptSha256: string;
  createdAt: string;
  updatedAt: string;
  lastMaterializedAt: string;
}

export type OccurrenceState =
  | "planned"
  | "dispatching"
  | "accepted"
  | "verified"
  | "deferred"
  | "blocked"
  | "failed"
  | "skipped";

export interface OccurrenceRecord {
  id: string;
  scheduleId: string;
  scheduleRevision: number;
  runKey: string;
  scheduledFor: string;
  state: OccurrenceState;
  commandId: string;
  messageId: string;
  threadId: string;
  schedule: ScheduleRecord;
  resolvedModelSelection: ModelSelection | null;
  attemptCount: number;
  receipt: unknown;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
}
