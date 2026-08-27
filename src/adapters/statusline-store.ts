import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseStatuslinePayload, type QuotaReading } from "../domain/limits.ts";
import type { StatuslineReader } from "./claude-quota.ts";

export interface StatuslineSnapshot {
  reading: QuotaReading;
  capturedAt: string;
}

/**
 * Zero-cost quota readings captured from Claude Code's statusline stdin. `rate_limits` appears
 * only in TUI sessions on a paid plan and only after the first response, so a missing or stale
 * file is the normal case, not an error.
 */
export class StatuslineStore implements StatuslineReader {
  constructor(private readonly directory: string) {}

  private path(profile: string): string {
    return join(this.directory, `${profile.replace(/[^a-z0-9._-]/gi, "_")}.json`);
  }

  read(profile: string): StatuslineSnapshot | null {
    try {
      const parsed = JSON.parse(readFileSync(this.path(profile), "utf8")) as StatuslineSnapshot;
      if (!parsed?.capturedAt || !Array.isArray(parsed.reading?.windows)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Returns false when the payload carried no rate limits, which is normal and not an error. */
  async capture(profile: string, payload: unknown, capturedAt: string): Promise<boolean> {
    const reading = parseStatuslinePayload(payload);
    if (!reading) return false;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(profile);
    const temporary = `${target}.tmp-${process.pid}`;
    const snapshot: StatuslineSnapshot = { reading, capturedAt };
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    await rename(temporary, target);
    return true;
  }
}
