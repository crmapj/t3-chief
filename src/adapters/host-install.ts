import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DefaultProcessRunner, type ProcessRunner } from "./host-jobs.ts";

export type WakeBackend = "systemd-user" | "cron";

const CRON_BEGIN = "# t3chief-scheduler:begin";
const CRON_END = "# t3chief-scheduler:end";

function validateExecutable(executable: string): void {
  if (!executable.startsWith("/") || !/^\/[A-Za-z0-9_./-]+$/.test(executable)) {
    throw new Error(
      "Scheduler executable must be an absolute path without spaces or shell syntax.",
    );
  }
}

function validateBackend(backend: WakeBackend): void {
  if (backend !== "systemd-user" && backend !== "cron") {
    throw new Error(`Unknown scheduler wake backend '${String(backend)}'.`);
  }
}

function serviceUnit(executable: string): string {
  return `[Unit]
Description=Reconcile t3-chief schedules and recovery work
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${executable} tick --apply --quiet
TimeoutStartSec=55
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
Nice=10
`;
}

function timerUnit(): string {
  return `[Unit]
Description=Wake the t3-chief scheduler every minute

[Timer]
OnCalendar=*-*-* *:*:00
AccuracySec=10s
Persistent=true
Unit=t3chief-scheduler.service

[Install]
WantedBy=timers.target
`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class SchedulerWakeInstaller {
  private readonly userUnitDirectory: string;
  private readonly backupDirectory: string;

  constructor(
    private readonly runner: ProcessRunner = new DefaultProcessRunner(),
    options: { userUnitDirectory?: string; backupDirectory?: string } = {},
  ) {
    const home = process.env.HOME ?? process.cwd();
    this.userUnitDirectory = options.userUnitDirectory ?? join(home, ".config", "systemd", "user");
    this.backupDirectory =
      options.backupDirectory ??
      join(process.env.XDG_STATE_HOME ?? join(home, ".local", "state"), "t3chief", "backups");
  }

  async install(backend: WakeBackend, executable: string): Promise<{ backend: WakeBackend }> {
    validateBackend(backend);
    validateExecutable(executable);
    if (backend === "systemd-user") await this.installSystemd(executable);
    else await this.installCron(executable);
    return { backend };
  }

  async uninstall(backend: WakeBackend): Promise<{ backend: WakeBackend }> {
    validateBackend(backend);
    if (backend === "systemd-user") await this.uninstallSystemd();
    else await this.uninstallCron();
    return { backend };
  }

  private async backup(path: string, label: string): Promise<void> {
    if (!(await exists(path))) return;
    await mkdir(this.backupDirectory, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    await writeFile(join(this.backupDirectory, `${label}-${stamp}`), await readFile(path), {
      mode: 0o600,
    });
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, path);
  }

  private async installSystemd(executable: string): Promise<void> {
    await mkdir(this.userUnitDirectory, { recursive: true, mode: 0o700 });
    const servicePath = join(this.userUnitDirectory, "t3chief-scheduler.service");
    const timerPath = join(this.userUnitDirectory, "t3chief-scheduler.timer");
    await this.backup(servicePath, "t3chief-scheduler.service");
    await this.backup(timerPath, "t3chief-scheduler.timer");
    await this.atomicWrite(servicePath, serviceUnit(executable));
    await this.atomicWrite(timerPath, timerUnit());
    await this.requireSuccess(
      await this.runner.run("systemctl", ["--user", "daemon-reload"]),
      "reload user systemd",
    );
    await this.requireSuccess(
      await this.runner.run("systemctl", ["--user", "enable", "--now", "t3chief-scheduler.timer"]),
      "enable t3chief-scheduler.timer",
    );
  }

  private async uninstallSystemd(): Promise<void> {
    await this.requireSuccess(
      await this.runner.run("systemctl", ["--user", "disable", "--now", "t3chief-scheduler.timer"]),
      "disable t3chief-scheduler.timer",
    );
    for (const name of ["t3chief-scheduler.service", "t3chief-scheduler.timer"]) {
      const path = join(this.userUnitDirectory, name);
      if (await exists(path)) {
        await this.backup(path, name);
        await unlink(path);
      }
    }
    await this.requireSuccess(
      await this.runner.run("systemctl", ["--user", "daemon-reload"]),
      "reload user systemd",
    );
  }

  private async readCrontab(): Promise<string> {
    const result = await this.runner.run("crontab", ["-l"]);
    if (result.exitCode === 0) return result.stdout;
    if (/no crontab for/i.test(result.stderr)) return "";
    throw new Error(`User crontab unavailable: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  private async installCron(executable: string): Promise<void> {
    const raw = await this.readCrontab();
    const block = `${CRON_BEGIN}\n* * * * * '${executable}' tick --apply --quiet\n${CRON_END}`;
    const pattern = new RegExp(`${CRON_BEGIN}[\\s\\S]*?${CRON_END}\\n?`, "g");
    const withoutOwnedBlock = raw.replace(pattern, "").trimEnd();
    const next = `${withoutOwnedBlock}${withoutOwnedBlock ? "\n" : ""}${block}\n`;
    await this.backupCrontab(raw);
    await this.requireSuccess(
      await this.runner.run("crontab", ["-"], { input: next }),
      "install the t3-chief cron wake job",
    );
  }

  private async uninstallCron(): Promise<void> {
    const raw = await this.readCrontab();
    const pattern = new RegExp(`${CRON_BEGIN}[\\s\\S]*?${CRON_END}\\n?`, "g");
    const next = raw.replace(pattern, "");
    if (next === raw) return;
    await this.backupCrontab(raw);
    await this.requireSuccess(
      await this.runner.run("crontab", ["-"], { input: next }),
      "remove the t3-chief cron wake job",
    );
  }

  private async backupCrontab(raw: string): Promise<void> {
    await mkdir(this.backupDirectory, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    await writeFile(join(this.backupDirectory, `crontab-${stamp}.txt`), raw, { mode: 0o600 });
  }

  private async requireSuccess(
    result: { exitCode: number; stdout: string; stderr: string },
    action: string,
  ): Promise<void> {
    if (result.exitCode !== 0) {
      throw new Error(`Could not ${action}: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  }
}
