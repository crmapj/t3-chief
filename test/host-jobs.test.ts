import { describe, expect, test } from "bun:test";

import {
  type CommandResult,
  CronJobSource,
  HostJobs,
  type ProcessRunner,
  SystemdJobSource,
} from "../src/adapters/host-jobs.ts";

class FakeRunner implements ProcessRunner {
  calls: Array<{ command: string; args: string[]; input?: string }> = [];
  responses = new Map<string, CommandResult>();

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
    return (
      this.responses.get([command, ...args].join(" ")) ?? { exitCode: 0, stdout: "", stderr: "" }
    );
  }
}

function systemdRunner(): FakeRunner {
  const runner = new FakeRunner();
  runner.responses.set("systemctl --user list-units --type=timer --all --output=json --no-pager", {
    exitCode: 0,
    stdout: JSON.stringify([
      {
        unit: "t3chief-scheduler.timer",
        active: "active",
        sub: "waiting",
        description: "Wake the t3-chief scheduler every minute",
      },
      {
        unit: "t3-nightly-update.timer",
        active: "active",
        sub: "waiting",
        description: "Update T3 nightly daily",
      },
    ]),
    stderr: "",
  });
  runner.responses.set("systemctl --user list-timers --all --output=json --no-pager", {
    exitCode: 0,
    stdout: JSON.stringify([
      {
        next: 1787889600000000,
        last: 1787803200000000,
        unit: "t3-nightly-update.timer",
        activates: "t3-nightly-update.service",
      },
      {
        next: 1787834400000000,
        last: 1787834340000000,
        unit: "t3chief-scheduler.timer",
        activates: "t3chief-scheduler.service",
      },
    ]),
    stderr: "",
  });
  runner.responses.set("systemctl list-units --type=timer --all --output=json --no-pager", {
    exitCode: 0,
    stdout: JSON.stringify([
      { unit: "apt-daily.timer", active: "active", sub: "waiting", description: "Daily apt" },
    ]),
    stderr: "",
  });
  runner.responses.set("systemctl list-timers --all --output=json --no-pager", {
    exitCode: 0,
    stdout: JSON.stringify([
      {
        next: 1787890000000000,
        last: 1787800000000000,
        unit: "apt-daily.timer",
        activates: "apt-daily.service",
      },
    ]),
    stderr: "",
  });
  return runner;
}

describe("host jobs", () => {
  test("normalizes user and system timers and highlights the two managed T3 jobs", async () => {
    const runner = systemdRunner();
    const jobs = new HostJobs(new SystemdJobSource(runner), new CronJobSource(runner));

    const inventory = await jobs.list();

    expect(inventory.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "systemd:user:t3chief-scheduler.timer",
          tags: ["t3", "scheduled-turn", "spend-limit", "maintenance-retry"],
          capabilities: ["enable", "disable", "run"],
        }),
        expect.objectContaining({
          ref: "systemd:user:t3-nightly-update.timer",
          tags: ["t3", "nightly-update"],
        }),
        expect.objectContaining({
          ref: "systemd:system:apt-daily.timer",
          capabilities: [],
        }),
      ]),
    );
  });

  test("controls user timers but keeps system timers read-only", async () => {
    const runner = systemdRunner();
    const jobs = new HostJobs(new SystemdJobSource(runner), new CronJobSource(runner));

    await jobs.manage("systemd:user:t3-nightly-update.timer", "disable");

    expect(runner.calls.at(-1)).toEqual({
      command: "systemctl",
      args: ["--user", "disable", "--now", "t3-nightly-update.timer"],
    });
    await expect(jobs.manage("systemd:system:apt-daily.timer", "disable")).rejects.toThrow(
      "read-only",
    );
  });

  test("surfaces an unavailable user crontab without hiding other jobs", async () => {
    const runner = systemdRunner();
    runner.responses.set("crontab -l", {
      exitCode: 1,
      stdout: "",
      stderr: "crontabs/example-user/: fopen: Permission denied",
    });
    const jobs = new HostJobs(new SystemdJobSource(runner), new CronJobSource(runner));

    const inventory = await jobs.list();

    expect(inventory.warnings).toContain(
      "User crontab unavailable: crontabs/example-user/: fopen: Permission denied",
    );
    expect(inventory.jobs.some((job) => job.ref === "systemd:user:t3-nightly-update.timer")).toBe(
      true,
    );
  });
});
