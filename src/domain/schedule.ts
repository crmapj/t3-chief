import { createHash } from "node:crypto";

import { CronExpressionParser } from "cron-parser";

export type Trigger =
  | { kind: "once"; at: string }
  | { kind: "cron"; expression: string; timeZone: string; until?: string };

const ID_NAMESPACE = "b92fa2cf-b5b6-51c7-94e2-c4ab71cfe1e7";
const SKIP_POLICY_JITTER_MS = 90_000;

export interface OccurrenceIds {
  occurrenceId: string;
  commandId: string;
  messageId: string;
  threadId: string;
}

function uuidBytes(value: string): Uint8Array {
  const hex = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new Error(`Invalid UUID: ${value}`);
  }
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
}

function uuidV5(name: string): string {
  const digest = createHash("sha1").update(uuidBytes(ID_NAMESPACE)).update(name).digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deterministicOccurrenceIds(
  scheduleId: string,
  scheduledFor: string,
): OccurrenceIds {
  const canonical = new Date(scheduledFor).toISOString();
  return deterministicRunIds(scheduleId, canonical);
}

export function deterministicRunIds(scheduleId: string, runKey: string): OccurrenceIds {
  const material = `t3chief-occurrence/v1\0${scheduleId}\0${runKey}`;
  const occurrenceId = `occ_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
  return {
    occurrenceId,
    commandId: uuidV5(`${occurrenceId}:turn`),
    messageId: uuidV5(`${occurrenceId}:message`),
    threadId: uuidV5(`${occurrenceId}:thread`),
  };
}

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function isRfc3339(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function validateTrigger(trigger: Trigger): string | null {
  if (trigger.kind === "once") {
    return isRfc3339(trigger.at) ? null : "Once trigger must use an RFC3339 timestamp.";
  }
  if (!isIanaTimeZone(trigger.timeZone)) {
    return `Unknown IANA time zone: ${trigger.timeZone}`;
  }
  if (trigger.until !== undefined && !isRfc3339(trigger.until)) {
    return "Cron until bound must use an RFC3339 timestamp.";
  }
  try {
    CronExpressionParser.parse(trigger.expression, { tz: trigger.timeZone });
    return null;
  } catch (error) {
    return `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function triggerExpired(trigger: Trigger, now: string): boolean {
  return (
    trigger.kind === "cron" &&
    trigger.until !== undefined &&
    new Date(now) > new Date(trigger.until)
  );
}

export function dueInstants(input: {
  trigger: Trigger;
  after: string;
  now: string;
  misfire: "latest" | "skip";
}): string[] {
  const error = validateTrigger(input.trigger);
  if (error) throw new Error(error);
  const after = new Date(input.after);
  const now = new Date(input.now);
  if (after >= now) return [];

  if (input.trigger.kind === "once") {
    const at = new Date(input.trigger.at);
    if (at <= after || at > now) return [];
    return input.misfire === "skip" && now.getTime() - at.getTime() > SKIP_POLICY_JITTER_MS
      ? []
      : [at.toISOString()];
  }

  const until = input.trigger.until === undefined ? null : new Date(input.trigger.until);
  const interval = CronExpressionParser.parse(input.trigger.expression, {
    currentDate: after,
    endDate: until && until < now ? until : now,
    tz: input.trigger.timeZone,
  });
  const due: string[] = [];
  for (;;) {
    try {
      due.push(interval.next().toDate().toISOString());
    } catch {
      break;
    }
  }
  if (input.misfire === "skip") {
    const latest = due.at(-1);
    return latest && now.getTime() - new Date(latest).getTime() <= SKIP_POLICY_JITTER_MS
      ? [latest]
      : [];
  }
  return due.length === 0 ? [] : [due.at(-1) as string];
}
