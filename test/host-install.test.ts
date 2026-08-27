import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchedulerWakeInstaller } from "../src/adapters/host-install.ts";
import type { CommandResult, ProcessRunner } from "../src/adapters/host-jobs.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

class FakeRunner implements ProcessRunner {
  calls: Array<{ command: string; args: string[]; input?: string }> = [];
  crontab = "15 4 * * * /home/operator/bin/existing\n";

  async run(
    command: string,
    args: string[],
    options: { input?: string } = {},
  ): Promise<CommandResult> {
    this.calls.push({
      command,
      args,
      ...(options.input === undefined ? {} : { input: options.input }),
    });
    if (command === "crontab" && args[0] === "-l") {
      return { exitCode: 0, stdout: this.crontab, stderr: "" };
    }
    if (command === "crontab" && args[0] === "-") {
      this.crontab = options.input ?? "";
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

describe("scheduler wake installation", () => {
  test("rejects an unknown backend without touching the host", async () => {
    const runner = new FakeRunner();
    const installer = new SchedulerWakeInstaller(runner);

    expect(
      installer.install("launchd" as never, "/home/operator/.local/bin/t3chief"),
    ).rejects.toThrow("Unknown scheduler wake backend");
    expect(runner.calls).toEqual([]);
  });

  test("installs one hardened persistent user systemd timer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3chief-systemd-"));
    directories.push(directory);
    const runner = new FakeRunner();
    const installer = new SchedulerWakeInstaller(runner, {
      userUnitDirectory: directory,
      backupDirectory: join(directory, "backups"),
    });

    await installer.install("systemd-user", "/home/operator/.local/bin/t3chief");

    const service = await readFile(join(directory, "t3chief-scheduler.service"), "utf8");
    const timer = await readFile(join(directory, "t3chief-scheduler.timer"), "utf8");
    expect(service).toContain("ExecStart=/home/operator/.local/bin/t3chief tick --apply --quiet");
    expect(service).toContain("NoNewPrivileges=true");
    expect(timer).toContain("OnCalendar=*-*-* *:*:00");
    expect(timer).toContain("Persistent=true");
    expect(runner.calls.at(-1)).toEqual({
      command: "systemctl",
      args: ["--user", "enable", "--now", "t3chief-scheduler.timer"],
    });
  });

  test("cron fallback preserves unrelated entries and owns one marked wake job", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3chief-cron-"));
    directories.push(directory);
    const runner = new FakeRunner();
    const installer = new SchedulerWakeInstaller(runner, {
      userUnitDirectory: join(directory, "units"),
      backupDirectory: join(directory, "backups"),
    });

    await installer.install("cron", "/home/operator/.local/bin/t3chief");
    await installer.install("cron", "/home/operator/.local/bin/t3chief");

    expect(runner.crontab).toContain("15 4 * * * /home/operator/bin/existing");
    expect(runner.crontab.match(/# t3chief-scheduler:begin/g)).toHaveLength(1);
    expect(runner.crontab).toContain(
      "* * * * * '/home/operator/.local/bin/t3chief' tick --apply --quiet",
    );
  });
});
