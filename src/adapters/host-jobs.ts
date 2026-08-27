import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(command: string, args: string[], options?: { input?: string }): Promise<CommandResult>;
}

export class DefaultProcessRunner implements ProcessRunner {
  async run(
    command: string,
    args: string[],
    options: { input?: string } = {},
  ): Promise<CommandResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
      if (options.input !== undefined) child.stdin?.end(options.input);
    });
  }
}

export type JobCapability = "enable" | "disable" | "run";
export type JobAction = JobCapability;

export interface HostJob {
  ref: string;
  source: "user-systemd" | "system-systemd" | "user-cron" | "system-cron";
  id: string;
  label: string;
  enabled: boolean;
  active?: string;
  schedule?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  command?: string;
  sourcePath?: string;
  capabilities: JobCapability[];
  tags: string[];
}

interface SystemdUnitRow {
  unit: string;
  active?: string;
  sub?: string;
  description?: string;
}

interface SystemdTimerRow {
  next?: number | null;
  last?: number | null;
  unit: string;
  activates?: string;
}

function systemdInstant(microseconds: number | null | undefined): string | undefined {
  if (!microseconds || microseconds <= 0) return undefined;
  return new Date(Math.floor(microseconds / 1_000)).toISOString();
}

function tagsForTimer(unit: string): string[] {
  if (unit === "t3chief-scheduler.timer") {
    return ["t3", "scheduled-turn", "spend-limit", "maintenance-retry"];
  }
  // Superseded by the composite t3chief wake timer; still tagged so `jobs` can explain it.
  if (unit.endsWith("t3-rate-limit-resume.timer")) return ["t3", "spend-limit", "legacy"];
  if (unit === "t3-nightly-resume.timer") return ["t3", "maintenance-retry", "legacy"];
  if (unit === "t3-nightly-update.timer") return ["t3", "nightly-update"];
  if (unit.startsWith("t3-") || unit.startsWith("t3chief-")) return ["t3"];
  return [];
}

export class SystemdJobSource {
  constructor(private readonly runner: ProcessRunner = new DefaultProcessRunner()) {}

  async list(scope: "user" | "system"): Promise<HostJob[]> {
    const prefix = scope === "user" ? ["--user"] : [];
    const [unitsResult, timersResult] = await Promise.all([
      this.runner.run("systemctl", [
        ...prefix,
        "list-units",
        "--type=timer",
        "--all",
        "--output=json",
        "--no-pager",
      ]),
      this.runner.run("systemctl", [
        ...prefix,
        "list-timers",
        "--all",
        "--output=json",
        "--no-pager",
      ]),
    ]);
    if (unitsResult.exitCode !== 0) {
      throw new Error(
        `${scope} systemd inventory failed: ${unitsResult.stderr.trim() || unitsResult.stdout.trim()}`,
      );
    }
    if (timersResult.exitCode !== 0) {
      throw new Error(
        `${scope} systemd timer inventory failed: ${timersResult.stderr.trim() || timersResult.stdout.trim()}`,
      );
    }
    const units = JSON.parse(unitsResult.stdout || "[]") as SystemdUnitRow[];
    const timers = JSON.parse(timersResult.stdout || "[]") as SystemdTimerRow[];
    const timing = new Map(timers.map((timer) => [timer.unit, timer]));
    return units.map((unit) => {
      const timer = timing.get(unit.unit);
      const nextRunAt = systemdInstant(timer?.next);
      const lastRunAt = systemdInstant(timer?.last);
      const capabilities: JobCapability[] = scope === "user" ? ["enable", "disable", "run"] : [];
      return {
        ref: `systemd:${scope}:${unit.unit}`,
        source: scope === "user" ? "user-systemd" : "system-systemd",
        id: unit.unit,
        label: unit.description ?? unit.unit,
        enabled: unit.active === "active",
        ...(unit.active ? { active: unit.active } : {}),
        ...(timer?.activates ? { schedule: `activates ${timer.activates}` } : {}),
        ...(nextRunAt ? { nextRunAt } : {}),
        ...(lastRunAt ? { lastRunAt } : {}),
        capabilities,
        tags: tagsForTimer(unit.unit),
      } satisfies HostJob;
    });
  }

  async manage(ref: string, action: JobAction): Promise<CommandResult> {
    const match = /^systemd:(user|system):(.+\.timer)$/.exec(ref);
    if (!match) throw new Error(`Invalid systemd job reference '${ref}'.`);
    const [, scope, unit] = match;
    if (scope !== "user") throw new Error(`System systemd job '${unit}' is read-only.`);
    const args = ["--user"];
    if (action === "enable") args.push("enable", "--now", unit as string);
    if (action === "disable") args.push("disable", "--now", unit as string);
    if (action === "run") args.push("start", (unit as string).replace(/\.timer$/, ".service"));
    const result = await this.runner.run("systemctl", args);
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not ${action} '${unit}': ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result;
  }
}

interface CronReadResult {
  jobs: HostJob[];
  warnings: string[];
  userRaw: string | null;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function parseCronLine(
  line: string,
  source: "user-cron" | "system-cron",
  sourcePath: string,
): HostJob | null {
  let enabled = true;
  let original = line;
  const disabled = /^# t3chief-disabled:([0-9a-f]{20}) (.*)$/.exec(line);
  if (disabled) {
    enabled = false;
    original = disabled[2] ?? "";
  } else if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
    return null;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(original.trim())) return null;

  const macro = /^(@\S+)\s+(.+)$/.exec(original.trim());
  const fields = original.trim().split(/\s+/);
  const isSystem = source === "system-cron";
  let schedule: string;
  let command: string;
  if (macro) {
    schedule = macro[1] as string;
    const remainder = macro[2] as string;
    if (isSystem) {
      const split = remainder.match(/^(\S+)\s+(.+)$/);
      if (!split) return null;
      command = split[2] as string;
    } else {
      command = remainder;
    }
  } else {
    const minimum = isSystem ? 7 : 6;
    if (fields.length < minimum) return null;
    schedule = fields.slice(0, 5).join(" ");
    command = fields.slice(isSystem ? 6 : 5).join(" ");
  }
  const id = digest(`${sourcePath}\0${original}`);
  return {
    ref: `cron:${source === "user-cron" ? "user" : "system"}:${id}`,
    source,
    id,
    label: command.length <= 90 ? command : `${command.slice(0, 87)}...`,
    enabled,
    schedule,
    command,
    sourcePath,
    capabilities: source === "user-cron" ? ["enable", "disable", "run"] : [],
    tags: /t3/i.test(command) ? ["t3"] : [],
  };
}

export class CronJobSource {
  constructor(
    private readonly runner: ProcessRunner = new DefaultProcessRunner(),
    private readonly options: {
      systemCrontab?: string;
      systemCronDirectory?: string;
      backupDirectory?: string;
    } = {},
  ) {}

  async list(): Promise<CronReadResult> {
    const jobs: HostJob[] = [];
    const warnings: string[] = [];
    const userResult = await this.runner.run("crontab", ["-l"]);
    let userRaw: string | null = null;
    if (userResult.exitCode === 0) {
      userRaw = userResult.stdout;
      for (const line of userRaw.split("\n")) {
        const job = parseCronLine(line, "user-cron", "user-crontab");
        if (job) jobs.push(job);
      }
    } else if (!/no crontab for/i.test(userResult.stderr)) {
      warnings.push(
        `User crontab unavailable: ${userResult.stderr.trim() || userResult.stdout.trim() || "unknown error"}`,
      );
    }

    const systemCrontab = this.options.systemCrontab ?? "/etc/crontab";
    const cronDirectory = this.options.systemCronDirectory ?? "/etc/cron.d";
    const systemFiles: string[] = [systemCrontab];
    try {
      const entries = await readdir(cronDirectory, { withFileTypes: true });
      systemFiles.push(
        ...entries
          .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
          .map((entry) => join(cronDirectory, entry.name)),
      );
    } catch (error) {
      warnings.push(
        `System cron directory unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const path of systemFiles) {
      try {
        const raw = await readFile(path, "utf8");
        for (const line of raw.split("\n")) {
          const job = parseCronLine(line, "system-cron", path);
          if (job) jobs.push(job);
        }
      } catch (error) {
        warnings.push(
          `Cron file '${path}' unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { jobs, warnings, userRaw };
  }

  async manage(ref: string, action: JobAction): Promise<CommandResult> {
    const match = /^cron:(user|system):([0-9a-f]{20})$/.exec(ref);
    if (!match) throw new Error(`Invalid cron job reference '${ref}'.`);
    const [, scope, id] = match;
    if (scope !== "user") throw new Error(`System cron job '${id}' is read-only.`);
    const initial = await this.list();
    if (initial.userRaw === null) throw new Error("User crontab is unavailable.");
    const job = initial.jobs.find((candidate) => candidate.ref === ref);
    if (!job?.command) throw new Error(`Cron job '${ref}' was not found.`);
    if (action === "run") {
      const result = await this.runner.run("sh", ["-s"], { input: `${job.command}\n` });
      if (result.exitCode !== 0) throw new Error(`Cron job failed: ${result.stderr.trim()}`);
      return result;
    }

    const lines = initial.userRaw.split("\n");
    let changed = false;
    const nextLines = lines.map((line) => {
      const parsed = parseCronLine(line, "user-cron", "user-crontab");
      if (parsed?.ref !== ref) return line;
      if (action === "disable" && parsed.enabled) {
        changed = true;
        return `# t3chief-disabled:${parsed.id} ${line}`;
      }
      if (action === "enable" && !parsed.enabled) {
        changed = true;
        return line.replace(/^# t3chief-disabled:[0-9a-f]{20} /, "");
      }
      return line;
    });
    if (!changed) return { exitCode: 0, stdout: "unchanged", stderr: "" };

    const confirm = await this.runner.run("crontab", ["-l"]);
    if (confirm.exitCode !== 0 || sha256Full(confirm.stdout) !== sha256Full(initial.userRaw)) {
      throw new Error("User crontab changed during the operation; no changes were written.");
    }
    const backupDirectory =
      this.options.backupDirectory ??
      join(
        process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? ".", ".local/state"),
        "t3chief",
        "backups",
      );
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    await writeFile(join(backupDirectory, `crontab-${stamp}.txt`), initial.userRaw, {
      mode: 0o600,
    });
    const result = await this.runner.run("crontab", ["-"], { input: nextLines.join("\n") });
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not install user crontab: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result;
  }
}

function sha256Full(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class HostJobs {
  constructor(
    private readonly systemd: SystemdJobSource,
    private readonly cron: CronJobSource,
  ) {}

  async list(): Promise<{ jobs: HostJob[]; warnings: string[] }> {
    const warnings: string[] = [];
    const jobs: HostJob[] = [];
    const results = await Promise.allSettled([
      this.systemd.list("user"),
      this.systemd.list("system"),
      this.cron.list(),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        warnings.push(
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        );
      } else if (Array.isArray(result.value)) {
        jobs.push(...result.value);
      } else {
        jobs.push(...result.value.jobs);
        warnings.push(...result.value.warnings);
      }
    }
    jobs.sort((left, right) => left.ref.localeCompare(right.ref));
    return { jobs, warnings };
  }

  async manage(ref: string, action: JobAction): Promise<CommandResult> {
    if (ref.startsWith("systemd:")) return this.systemd.manage(ref, action);
    if (ref.startsWith("cron:")) return this.cron.manage(ref, action);
    throw new Error(`Unsupported host job reference '${ref}'.`);
  }
}
