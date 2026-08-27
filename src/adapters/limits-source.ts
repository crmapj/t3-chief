import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { ClaudeTranscriptFile, LimitsFile, LimitsSource, LimitsTail } from "../core/limits.ts";

export interface HostLimitsSourceOptions {
  /** Defaults to `$HOME/.codex/sessions`. */
  codexSessionsDirectory?: string;
  /**
   * Claude Code data roots, each containing a `projects/` directory. Defaults to `$HOME/.claude`
   * plus every direct child of `$HOME/.claude-profiles`, so single-profile and multi-profile hosts
   * both work without configuration.
   */
  claudeRoots?: string[];
  home?: string;
}

const ROLLOUT = /^rollout-.*\.jsonl$/;

/** Reads provider artifacts under the user's home directory. Never writes and never opens SQLite. */
export class HostLimitsSource implements LimitsSource {
  private readonly codexSessionsDirectory: string;
  private readonly explicitClaudeRoots: string[] | undefined;
  private readonly home: string;

  constructor(options: HostLimitsSourceOptions = {}) {
    this.home = options.home ?? homedir();
    this.codexSessionsDirectory =
      options.codexSessionsDirectory ?? join(this.home, ".codex", "sessions");
    this.explicitClaudeRoots = options.claudeRoots;
  }

  async codexRollouts(): Promise<LimitsFile[]> {
    const names = await listFiles(this.codexSessionsDirectory, (name) => ROLLOUT.test(name));
    const files = await describeAll(names.map((path) => ({ path })));
    return files.sort(byRecency);
  }

  async claudeTranscripts(): Promise<ClaudeTranscriptFile[]> {
    const roots = this.explicitClaudeRoots ?? (await this.discoverClaudeRoots());
    const candidates: Array<{ path: string; profile: string }> = [];
    for (const root of roots) {
      const paths = await listFiles(join(root, "projects"), (name) => name.endsWith(".jsonl"));
      for (const path of paths) candidates.push({ path, profile: basename(root) });
    }
    const files = await describeAll(candidates);
    return files.sort(byRecency);
  }

  async readTail(path: string, maxBytes: number): Promise<LimitsTail> {
    const handle = await open(path, "r");
    try {
      const size = (await handle.stat()).size;
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const text = buffer.toString("utf8");
      if (length === size) return { text, truncated: false };
      const boundary = text.indexOf("\n");
      return { text: boundary === -1 ? "" : text.slice(boundary + 1), truncated: true };
    } finally {
      await handle.close();
    }
  }

  private async discoverClaudeRoots(): Promise<string[]> {
    const roots: string[] = [];
    const single = join(this.home, ".claude");
    if (await isDirectory(join(single, "projects"))) roots.push(single);
    const profilesDirectory = join(this.home, ".claude-profiles");
    let entries: string[] = [];
    try {
      entries = (await readdir(profilesDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(profilesDirectory, entry.name));
    } catch {
      return roots;
    }
    for (const entry of entries.sort()) {
      if (await isDirectory(join(entry, "projects"))) roots.push(entry);
    }
    return roots;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function listFiles(root: string, accept: (name: string) => boolean): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true, recursive: true });
    return entries
      .filter((entry) => entry.isFile() && accept(entry.name))
      .map((entry) => join(entry.parentPath ?? root, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function describeAll<T extends { path: string }>(
  candidates: readonly T[],
): Promise<Array<T & { modifiedAt: string }>> {
  const described: Array<T & { modifiedAt: string }> = [];
  await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const info = await stat(candidate.path);
        described.push({ ...candidate, modifiedAt: info.mtime.toISOString() });
      } catch {
        // A session file can be rotated away between listing and stat; skip it.
      }
    }),
  );
  return described;
}

/** Newest modification first, then path, so equal timestamps still order deterministically. */
function byRecency<T extends LimitsFile>(left: T, right: T): number {
  return right.modifiedAt.localeCompare(left.modifiedAt) || left.path.localeCompare(right.path);
}
