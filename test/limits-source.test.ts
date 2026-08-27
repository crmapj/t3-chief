import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostLimitsSource } from "../src/adapters/limits-source.ts";

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "t3chief-limits-"));
}

describe("host limits source", () => {
  test("finds rollouts under the dated Codex tree, newest modification first", async () => {
    const home = await fixture();
    try {
      const day = join(home, ".codex", "sessions", "2026", "08", "27");
      await mkdir(day, { recursive: true });
      await writeFile(join(day, "rollout-a.jsonl"), "a\n");
      await writeFile(join(day, "rollout-b.jsonl"), "b\n");
      await writeFile(join(day, "notes.txt"), "ignored\n");

      const files = await new HostLimitsSource({ home }).codexRollouts();

      expect(files).toHaveLength(2);
      expect(files.map((file) => file.path.endsWith(".jsonl"))).toEqual([true, true]);
      expect((files[0]?.modifiedAt ?? "") >= (files[1]?.modifiedAt ?? "")).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("discovers every Claude profile that has a projects directory", async () => {
    const home = await fixture();
    try {
      await mkdir(join(home, ".claude", "projects", "repo"), { recursive: true });
      await writeFile(join(home, ".claude", "projects", "repo", "one.jsonl"), "{}\n");
      await mkdir(join(home, ".claude-profiles", "personal", "projects", "repo"), {
        recursive: true,
      });
      await writeFile(
        join(home, ".claude-profiles", "personal", "projects", "repo", "two.jsonl"),
        "{}\n",
      );
      await mkdir(join(home, ".claude-profiles", "empty"), { recursive: true });

      const files = await new HostLimitsSource({ home }).claudeTranscripts();

      expect(files.map((file) => file.profile).sort()).toEqual([".claude", "personal"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("returns no files instead of throwing when a provider directory is absent", async () => {
    const home = await fixture();
    try {
      const source = new HostLimitsSource({ home });

      expect(await source.codexRollouts()).toEqual([]);
      expect(await source.claudeTranscripts()).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("reads the tail from a line boundary so no partial JSON is parsed", async () => {
    const home = await fixture();
    try {
      const path = join(home, "rollout.jsonl");
      await writeFile(path, '{"n":1}\n{"n":2}\n{"n":3}\n');
      const source = new HostLimitsSource({ home });

      expect(await source.readTail(path, 1_000)).toEqual({
        text: '{"n":1}\n{"n":2}\n{"n":3}\n',
        truncated: false,
      });
      expect(await source.readTail(path, 12)).toEqual({ text: '{"n":3}\n', truncated: true });
      expect(await source.readTail(path, 3)).toEqual({ text: "", truncated: true });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
