import { createHash } from "node:crypto";

const ID_NAMESPACE = "263bdb17-c68c-5da8-8af7-b84a78969474";
const LIMIT_MESSAGE =
  /^You've hit your session limit\s*[·-]\s*resets\s+(\d{1,2})(?::(\d{2}))?(am|pm)\s*\(UTC\)$/i;

export type RateLimitSignalStatus =
  | "watching"
  | "dispatching"
  | "woke"
  | "ignored-late"
  | "expired"
  | "superseded"
  | "gone";

export interface RateLimitSignalRecord {
  environment: string;
  messageId: string;
  threadId: string;
  title: string;
  messageAt: string;
  resetAt: string;
  dueAt: string;
  status: RateLimitSignalStatus;
  commandId: string;
  continuationMessageId: string;
  attemptCount: number;
  detectedAt: string;
  updatedAt: string;
  wokeAt: string | null;
  lastError: string | null;
}

export type MaintenanceWindowStatus = "open" | "stopped" | "complete";
export type MaintenanceTurnStatus = "pending" | "dispatching" | "delivered" | "superseded" | "gone";

export interface MaintenanceWindowRecord {
  id: string;
  environment: string;
  status: MaintenanceWindowStatus;
  openedAt: string;
  stoppedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface MaintenanceTurnRecord {
  windowId: string;
  threadId: string;
  turnId: string;
  title: string;
  requestedAt: string | null;
  capturedAt: string;
  status: MaintenanceTurnStatus;
  commandId: string;
  messageId: string;
  attemptCount: number;
  updatedAt: string;
  deliveredAt: string | null;
  lastError: string | null;
}

function uuidBytes(value: string): Uint8Array {
  const hex = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`Invalid UUID: ${value}`);
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

export function parseSessionLimitReset(text: string, messageAt: string): string | null {
  const match = LIMIT_MESSAGE.exec(text.trim());
  const instant = new Date(messageAt);
  if (!match || !Number.isFinite(instant.getTime())) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (hour === 12) hour = 0;
  if (match[3]?.toLowerCase() === "pm") hour += 12;
  const reset = new Date(instant);
  reset.setUTCHours(hour, minute, 0, 0);
  if (reset <= instant) reset.setUTCDate(reset.getUTCDate() + 1);
  return reset.toISOString();
}

export function rateLimitDispatchIds(
  environment: string,
  messageId: string,
): { commandId: string; messageId: string } {
  const key = `t3chief-rate-limit/v1\0${environment}\0${messageId}`;
  return {
    commandId: uuidV5(`${key}:command`),
    messageId: uuidV5(`${key}:message`),
  };
}

export function maintenanceDispatchIds(
  windowId: string,
  threadId: string,
  turnId: string,
): { commandId: string; messageId: string } {
  const key = `t3chief-maintenance/v1\0${windowId}\0${threadId}\0${turnId}`;
  return {
    commandId: uuidV5(`${key}:command`),
    messageId: uuidV5(`${key}:message`),
  };
}

export function maintenanceWindowId(environment: string, openedAt: string): string {
  return `mw_${createHash("sha256")
    .update(`t3chief-maintenance-window/v1\0${environment}\0${openedAt}`)
    .digest("hex")
    .slice(0, 32)}`;
}
