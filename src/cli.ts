import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Command, CommanderError, Option } from "commander";
import { ClaudeQuotaSource } from "./adapters/claude-quota.ts";
import { CodexQuotaSource } from "./adapters/codex-quota.ts";
import { GrokQuotaSource } from "./adapters/grok-quota.ts";
import { SchedulerWakeInstaller, type WakeBackend } from "./adapters/host-install.ts";
import { type HostJob, HostJobs, type JobAction } from "./adapters/host-jobs.ts";
import { ScheduleLedger } from "./adapters/ledger.ts";
import { HostLimitsSource } from "./adapters/limits-source.ts";
import { StatuslineStore } from "./adapters/statusline-store.ts";
import {
  isInsecureT3Url,
  type ModelOptionValue,
  type ModelSelection,
  type ProviderCatalog,
  type T3ClientOptions,
  T3V1Client,
} from "./adapters/t3-v1.ts";
import { ConfigStore, defaultRunCommand, exchangePairingCredential } from "./config.ts";
import { FleetManager, type ProjectSummary, type T3FleetPort } from "./core/fleet.ts";
import { LimitsReporter, type LimitsSource, type ProviderProbe } from "./core/limits.ts";
import { MaintenanceManager, RateLimitManager } from "./core/maintenance.ts";
import { Scheduler, type SchedulerT3Port } from "./core/scheduler.ts";
import type { LimitsReport } from "./domain/limits.ts";
import type { InteractionMode, RuntimeMode, ScheduleRequest } from "./domain/model.ts";

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

interface HostJobsPort {
  list(): Promise<{ jobs: HostJob[]; warnings: string[] }>;
  manage(ref: string, action: JobAction): Promise<unknown>;
}

type T3Port = SchedulerT3Port & T3FleetPort;

export interface CliDependencies {
  configStore?: ConfigStore;
  ledger?: ScheduleLedger;
  resolveEnvironment?: (environment?: string) => Promise<T3Port>;
  createT3Client?: (options: T3ClientOptions) => Pick<T3V1Client, "descriptor" | "shell">;
  hostJobs?: HostJobsPort;
  limitsSource?: LimitsSource;
  claudeProbe?: ProviderProbe;
  codexProbe?: ProviderProbe;
  grokProbe?: ProviderProbe;
  writeOut?: (value: string) => void;
  writeErr?: (value: string) => void;
  readStdin?: () => Promise<string>;
}

interface OutputEnvelope {
  version: 1;
  ok: true;
  command: string;
  data: unknown;
}

function redactPrompts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPrompts);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "prompt")
      .map(([key, child]) => [key, redactPrompts(child)]),
  );
}

function redactCronCommands(jobs: HostJob[]): HostJob[] {
  return jobs.map((job) => {
    if (job.source !== "user-cron" && job.source !== "system-cron") return job;
    const { command: _command, ...redacted } = job;
    return { ...redacted, label: "Cron command (redacted)" };
  });
}

interface ScheduleCliOptions {
  at?: string;
  cron?: string;
  timezone?: string;
  until?: string;
  thread?: string;
  project?: string;
  newThread?: string;
  provider?: string;
  model?: string;
  option: string[];
  effort?: string;
  runtimeMode: string;
  interactionMode: string;
  worktree?: boolean;
  baseBranch: string;
  startFromOrigin?: boolean;
  prompt?: string;
  promptFile?: string;
  misfire: "latest" | "skip";
  whenBusy: "defer" | "skip";
  disabled?: boolean;
  expectedRevision?: string;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function scalar(value: string): ModelOptionValue {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:\d+|\d*\.\d+)$/.test(value)) return Number(value);
  return value;
}

function explicitOptions(values: string[]): Array<{ id: string; value: ModelOptionValue }> {
  return values.map((entry) => {
    const index = entry.indexOf("=");
    if (index <= 0) throw new Error(`Model option '${entry}' must use id=value.`);
    return { id: entry.slice(0, index), value: scalar(entry.slice(index + 1)) };
  });
}

async function defaultReadStdin(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) value += chunk.toString();
  return value;
}

export function withReplyTo(text: string, replyTo: string | undefined): string {
  if (replyTo === undefined) return text;
  const id = replyTo.trim();
  if (id.length === 0) throw new Error("--reply-to requires a thread id.");
  return [
    text.trimEnd(),
    "",
    "---",
    `REPLY-TO THREAD: ${id}`,
    `The delegating manager runs in T3 thread ${id}. When you complete this work, become blocked,`,
    "or need a decision, report back with:",
    "",
    `  t3chief thread send ${id} --prompt 'Concise status: outcome, evidence, open questions.'`,
    "",
    "Send one concise reply, not a transcript. Never settle or interrupt that thread.",
    "",
  ].join("\n");
}

async function promptText(
  options: { prompt?: string; promptFile?: string },
  readStdin: () => Promise<string>,
): Promise<string> {
  const count = Number(options.prompt !== undefined) + Number(options.promptFile !== undefined);
  if (count > 1) throw new Error("Use only one of --prompt or --prompt-file.");
  if (options.prompt !== undefined) return options.prompt;
  if (options.promptFile !== undefined) return readFile(options.promptFile, "utf8");
  if (process.stdin.isTTY)
    throw new Error("Provide --prompt, --prompt-file, or pipe prompt text on stdin.");
  return readStdin();
}

async function tokenFromInput(
  options: {
    tokenStdin?: boolean;
    pairingStdin?: boolean;
    tokenFile?: string;
    url: string;
    insecure?: boolean;
  },
  readStdin: () => Promise<string>,
): Promise<string> {
  const count =
    Number(options.tokenStdin === true) +
    Number(options.pairingStdin === true) +
    Number(options.tokenFile !== undefined);
  if (count !== 1) {
    throw new Error("Use exactly one of --token-stdin, --pairing-stdin, or --token-file.");
  }
  const credential = (
    options.tokenFile ? await readFile(options.tokenFile, "utf8") : await readStdin()
  ).trim();
  if (!credential) throw new Error("Credential input was empty.");
  if (!options.pairingStdin) return credential;
  return (
    await exchangePairingCredential({
      baseUrl: options.url,
      pairingCredential: credential,
      allowInsecure: options.insecure === true,
    })
  ).accessToken;
}

function formatHuman(command: string, data: unknown): string {
  if (command === "providers") {
    const catalog = data as ProviderCatalog;
    return catalog.providers
      .flatMap((provider) => [
        `${provider.instanceId} (${provider.driver}, ${provider.status}, ${provider.availability ?? "available"}, auth=${provider.authStatus ?? "unknown"})`,
        ...provider.models.map((model) => {
          const options = model.optionDescriptors
            .map((descriptor) => {
              const values = descriptor.options?.map((option) => option.id).join("|");
              return `${descriptor.id}${values ? `=${values}` : `:${descriptor.type}`}`;
            })
            .join(", ");
          return `  ${model.slug}${model.isDefault ? " [default]" : ""}${options ? `  ${options}` : ""}`;
        }),
      ])
      .join("\n");
  }
  if (command === "status") {
    const status = data as {
      summary: Record<string, number>;
      threads: Array<Record<string, unknown>>;
    };
    return [
      Object.entries(status.summary)
        .map(([key, value]) => `${key}=${value}`)
        .join("  "),
      ...status.threads.map(
        (thread) =>
          `${String(thread.state).padEnd(18)} ${String(thread.id).slice(0, 12)}  ${thread.projectTitle} / ${thread.title}`,
      ),
    ].join("\n");
  }
  if (command === "limits") {
    const report = data as LimitsReport;
    return report.providers
      .flatMap((provider) => [
        `${(provider.profile ? `${provider.provider}/${provider.profile}` : provider.provider).padEnd(26)} source=${provider.source.padEnd(14)} observed=${provider.observedAt ?? "never"}`,
        ...provider.windows.map((window) => {
          const used = window.usedPercent === null ? "n/a" : `${window.usedPercent}%`;
          return `  ${window.label.padEnd(8)} ${used.padStart(6)} used  resets=${window.resetsAt ?? "rolling"}`;
        }),
        ...(provider.credits
          ? [
              `  credits  balance=${provider.credits.balance ?? "unknown"} has=${provider.credits.hasCredits} unlimited=${provider.credits.unlimited}`,
            ]
          : []),
        ...(provider.usage
          ? [
              `  usage    ${provider.usage.requests} requests, ${provider.usage.totalTokens} tokens since ${provider.usage.windowStartedAt}`,
            ]
          : []),
        ...(provider.notes ?? []).map((note) => `  note     ${note}`),
      ])
      .join("\n");
  }
  if (command === "project.list") {
    const inventory = data as { projects: ProjectSummary[] };
    return inventory.projects
      .map(
        (entry) =>
          `${entry.id.padEnd(38)} ${String(entry.threadCount).padStart(4)} ${entry.threadCount === 1 ? "thread " : "threads"}  ${entry.title}  ${entry.workspaceRoot}`,
      )
      .join("\n");
  }
  if (command === "jobs") {
    const inventory = data as { jobs: Array<Record<string, unknown>>; warnings: string[] };
    return [
      ...inventory.jobs.map(
        (job) =>
          `${job.enabled ? "on " : "off"} ${String(job.ref).padEnd(56)} ${job.nextRunAt ?? ""} ${job.label}`,
      ),
      ...inventory.warnings.map((warning) => `warning: ${warning}`),
    ].join("\n");
  }
  return JSON.stringify(data, null, 2);
}

function effortOption(catalog: ProviderCatalog, selection: ModelSelection, effort: string) {
  const provider = catalog.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  const model = provider?.models.find((candidate) => candidate.slug === selection.model);
  const descriptor = model?.optionDescriptors.find(
    (candidate) =>
      ["reasoningEffort", "effort", "variant"].includes(candidate.id) ||
      candidate.label.toLowerCase().includes("reasoning"),
  );
  if (!descriptor) {
    throw new Error(
      `Model '${selection.instanceId}/${selection.model}' advertises no effort option.`,
    );
  }
  if (descriptor.type !== "select" || !descriptor.options?.some((option) => option.id === effort)) {
    throw new Error(
      `Effort '${effort}' is unavailable for '${selection.instanceId}/${selection.model}'.`,
    );
  }
  return { id: descriptor.id, value: effort };
}

function triggerFromOptions(options: {
  at?: string;
  cron?: string;
  timezone?: string;
  until?: string;
}) {
  if (Boolean(options.at) === Boolean(options.cron)) {
    throw new Error("Use exactly one of --at or --cron.");
  }
  if (options.at) {
    if (options.until) throw new Error("--until applies only to --cron schedules.");
    return { kind: "once" as const, at: options.at };
  }
  if (!options.timezone) throw new Error("Cron schedules require --timezone with an IANA zone.");
  return {
    kind: "cron" as const,
    expression: options.cron as string,
    timeZone: options.timezone,
    ...(options.until ? { until: options.until } : {}),
  };
}

function claudeTokenBudget(flag: string | undefined): number | null {
  const raw = flag ?? process.env.T3CHIEF_CLAUDE_TOKEN_BUDGET;
  if (raw === undefined || raw.trim().length === 0) return null;
  const budget = Number(raw);
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error("--claude-budget expects a positive token count.");
  }
  return budget;
}

export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const writeOut = dependencies.writeOut ?? ((value) => process.stdout.write(value));
  const writeErr = dependencies.writeErr ?? ((value) => process.stderr.write(value));
  const readStdin = dependencies.readStdin ?? defaultReadStdin;
  const config = dependencies.configStore ?? new ConfigStore();
  let ownedLedger: ScheduleLedger | undefined;
  if (!dependencies.ledger) {
    await config.ensureStateDirectory();
    ownedLedger = new ScheduleLedger(config.databasePath);
  }
  const ledger = dependencies.ledger ?? (ownedLedger as ScheduleLedger);
  const resolveEnvironment =
    dependencies.resolveEnvironment ??
    (async (name?: string) => config.client(name === "default" ? undefined : name));
  const createT3Client =
    dependencies.createT3Client ?? ((options: T3ClientOptions) => new T3V1Client(options));
  const hostJobs =
    dependencies.hostJobs ??
    new HostJobs(
      new (await import("./adapters/host-jobs.ts")).SystemdJobSource(),
      new (await import("./adapters/host-jobs.ts")).CronJobSource(),
    );

  const program = new Command();
  const jsonRequested = argv.includes("--json");
  program
    .name("t3chief")
    .description("Chief-of-staff control plane for T3 Code fleets")
    .version("0.8.0")
    .option("--json", "emit a stable JSON envelope")
    .option("--quiet", "suppress successful output")
    .option("--environment <name>", "T3 environment alias")
    .option("--include-prompt", "include stored schedule prompt bodies in output")
    .exitOverride()
    .configureOutput({
      writeOut,
      writeErr: (value) => {
        if (!jsonRequested) writeErr(value);
      },
    });

  const globals = () =>
    program.opts<{
      json?: boolean;
      quiet?: boolean;
      environment?: string;
      includePrompt?: boolean;
    }>();
  const environmentName = async (): Promise<string> => {
    if (globals().environment) return globals().environment as string;
    if (dependencies.resolveEnvironment) return "default";
    return (await config.load()).defaultEnvironment ?? "default";
  };
  const scheduler = new Scheduler(ledger, async (environment) => resolveEnvironment(environment));
  const maintenance = new MaintenanceManager(ledger, async (environment) =>
    resolveEnvironment(environment),
  );
  const rateLimits = new RateLimitManager(ledger, async (environment) =>
    resolveEnvironment(environment),
  );
  const fleet = async () => new FleetManager(await resolveEnvironment(globals().environment));
  const emit = (command: string, data: unknown) => {
    if (globals().quiet) return;
    const visible = globals().includePrompt ? data : redactPrompts(data);
    if (globals().json) {
      const envelope: OutputEnvelope = { version: 1, ok: true, command, data: visible };
      writeOut(`${JSON.stringify(envelope)}\n`);
    } else {
      writeOut(`${formatHuman(command, visible)}\n`);
    }
  };

  program
    .command("providers")
    .description("show the live T3 provider/model/option catalog")
    .action(async () => {
      emit("providers", await (await resolveEnvironment(globals().environment)).catalog());
    });

  const limits = program
    .command("limits")
    .description("report per-provider quota headroom")
    .option("--provider <name>", "restrict the report to one provider (repeatable)", collect, [])
    .option("--claude-budget <tokens>", "token denominator for the Claude estimate window")
    .option("--window-minutes <minutes>", "trailing window for the Claude estimate", "300")
    .option("--no-probe", "never call a provider endpoint; use cached and local readings only")
    .action(
      async (options: {
        provider: string[];
        claudeBudget?: string;
        windowMinutes: string;
        probe: boolean;
      }) => {
        const windowMinutes = Number(options.windowMinutes);
        if (!Number.isInteger(windowMinutes) || windowMinutes <= 0) {
          throw new Error("--window-minutes expects a positive whole number of minutes.");
        }
        const claudeProfiles = await config.listClaudeProfiles();
        const allowInference = options.probe !== false;
        const claude =
          dependencies.claudeProbe ??
          (claudeProfiles.length > 0
            ? new ClaudeQuotaSource({
                profiles: claudeProfiles,
                cache: ledger,
                runCommand: defaultRunCommand,
                statusline: new StatuslineStore(join(config.stateDirectory, "statusline")),
                allowInference,
              })
            : undefined);
        const codex =
          dependencies.codexProbe ?? new CodexQuotaSource({ cache: ledger, allowInference });
        const grok =
          dependencies.grokProbe ?? new GrokQuotaSource({ cache: ledger, allowInference });
        const reporter = new LimitsReporter({
          source: dependencies.limitsSource ?? new HostLimitsSource(),
          claudeTokenBudget: claudeTokenBudget(options.claudeBudget),
          claudeWindowMinutes: windowMinutes,
          probes: { codex, grok, ...(claude ? { claude } : {}) },
        });
        emit("limits", await reporter.report({ providers: options.provider }));
      },
    );
  limits
    .command("configure-claude")
    .description("register how to obtain an OAuth token for a Claude profile")
    .option("--profile <name>", "profile name to add or replace")
    .option("--command <argv...>", "absolute executable and arguments printing the token on stdout")
    .option("--remove <name>", "forget a configured profile")
    .action(async (options: { profile?: string; command?: string[]; remove?: string }) => {
      if (options.remove) {
        emit("limits.configure-claude", {
          profiles: await config.removeClaudeProfile(options.remove),
        });
        return;
      }
      if (!options.profile && !options.command) {
        emit("limits.configure-claude", { profiles: await config.listClaudeProfiles() });
        return;
      }
      if (!options.profile || !options.command?.length) {
        throw new Error("Configuring a Claude profile needs both --profile and --command.");
      }
      emit("limits.configure-claude", {
        profiles: await config.setClaudeProfile({
          name: options.profile,
          tokenCommand: options.command,
        }),
      });
    });
  limits
    .command("statusline-sink")
    .description("capture quota from Claude Code statusline JSON on stdin, then stay silent")
    .option("--profile <name>", "Claude profile this statusline belongs to", "default")
    .option(
      "--exec <argv...>",
      "run this statusline command with the same input and pass it through",
    )
    .action(async (options: { profile: string; exec?: string[] }) => {
      const input = await readStdin();
      let payload: unknown = null;
      try {
        payload = JSON.parse(input) as unknown;
      } catch {
        payload = null;
      }
      const store = new StatuslineStore(join(config.stateDirectory, "statusline"));
      const captured = payload
        ? await store.capture(options.profile, payload, new Date().toISOString())
        : false;
      if (options.exec?.length) {
        const [executable, ...args] = options.exec as [string, ...string[]];
        const { DefaultProcessRunner } = await import("./adapters/host-jobs.ts");
        const result = await new DefaultProcessRunner().run(executable, args, { input });
        writeOut(result.stdout);
        if (result.exitCode !== 0) writeErr(result.stderr);
        return;
      }
      if (globals().json) emit("limits.statusline-sink", { profile: options.profile, captured });
    });

  program
    .command("status")
    .description("show active unsettled T3 threads without loading bodies")
    .action(async () => {
      emit("status", await (await fleet()).status());
    });

  program
    .command("brief")
    .argument("<thread>")
    .option("--turns <count>", "number of recent user turns", "50")
    .action(async (thread, options) => {
      emit("brief", await (await fleet()).brief(thread, { turnLimit: Number(options.turns) }));
    });

  program
    .command("settle-ready")
    .option("--apply", "apply the displayed settlement plan")
    .action(async (options) => {
      emit("settle-ready", await (await fleet()).settleReady({ apply: options.apply === true }));
    });

  const thread = program.command("thread").description("drive T3 threads");
  thread
    .command("send")
    .argument("<thread>")
    .option("--prompt <text>")
    .option("--prompt-file <path>")
    .option(
      "--reply-to <thread>",
      "sender's own thread id; appends a deterministic reply-back footer",
    )
    .action(async (reference, options) => {
      emit(
        "thread.send",
        await (await fleet()).send(
          reference,
          withReplyTo(await promptText(options, readStdin), options.replyTo),
        ),
      );
    });
  thread
    .command("settle")
    .argument("<thread>")
    .action(async (reference) =>
      emit("thread.settle", await (await fleet()).setSettlement(reference, true)),
    );
  thread
    .command("unsettle")
    .argument("<thread>")
    .action(async (reference) =>
      emit("thread.unsettle", await (await fleet()).setSettlement(reference, false)),
    );
  thread
    .command("interrupt")
    .argument("<thread>")
    .action(async (reference) =>
      emit("thread.interrupt", await (await fleet()).interrupt(reference)),
    );
  thread
    .command("start")
    .requiredOption("--project <id>")
    .requiredOption("--title <title>")
    .requiredOption("--provider <instance>")
    .requiredOption("--model <slug>")
    .option("--option <id=value>", "live provider model option", collect, [])
    .option("--effort <value>", "live-advertised model effort")
    .option("--runtime-mode <mode>", "T3 runtime mode", "full-access")
    .option("--interaction-mode <mode>", "T3 interaction mode", "default")
    .option("--worktree", "create a managed worktree")
    .option("--base-branch <branch>", "managed worktree base branch", "main")
    .option("--start-from-origin", "start the worktree from the remote tracking commit")
    .option("--prompt <text>")
    .option("--prompt-file <path>")
    .option(
      "--reply-to <thread>",
      "sender's own thread id; appends a deterministic reply-back footer",
    )
    .action(async (options) => {
      const client = await resolveEnvironment(globals().environment);
      const selection: ModelSelection = {
        instanceId: options.provider,
        model: options.model,
        options: explicitOptions(options.option),
      };
      if (options.effort)
        selection.options?.push(effortOption(await client.catalog(), selection, options.effort));
      emit(
        "thread.start",
        await new FleetManager(client).start({
          projectId: options.project,
          title: options.title,
          text: withReplyTo(await promptText(options, readStdin), options.replyTo),
          modelSelection: selection,
          runtimeMode: options.runtimeMode as RuntimeMode,
          interactionMode: options.interactionMode as InteractionMode,
          checkout: options.worktree
            ? {
                kind: "managed-worktree",
                baseBranch: options.baseBranch,
                ...(options.startFromOrigin ? { startFromOrigin: true } : {}),
              }
            : { kind: "project-workspace" },
        }),
      );
    });

  const project = program.command("project").description("inspect and register T3 projects");
  project
    .command("list")
    .description("list projects from the shell snapshot with their thread counts")
    .action(async () => emit("project.list", await (await fleet()).listProjects()));
  project
    .command("create")
    .description("register a workspace directory as a T3 project")
    .requiredOption("--title <title>")
    .requiredOption("--workspace <absolute-path>", "absolute workspace root for the project")
    .option("--create-workspace", "let T3 create the workspace root when it does not exist")
    .option("--provider <instance>", "default provider instance for new threads")
    .option("--model <slug>", "default model slug for new threads")
    .option("--option <id=value>", "default provider model option", collect, [])
    .option("--effort <value>", "live-advertised default model effort")
    .action(async (options) => {
      const client = await resolveEnvironment(globals().environment);
      if (Boolean(options.provider) !== Boolean(options.model)) {
        throw new Error("A project default route needs both --provider and --model.");
      }
      if (!options.provider && (options.effort || options.option.length > 0)) {
        throw new Error("--effort and --option apply only with --provider and --model.");
      }
      let selection: ModelSelection | undefined;
      if (options.provider) {
        selection = {
          instanceId: options.provider,
          model: options.model,
          options: explicitOptions(options.option),
        };
        if (options.effort)
          selection.options?.push(effortOption(await client.catalog(), selection, options.effort));
      }
      emit(
        "project.create",
        await new FleetManager(client).createProject({
          title: options.title,
          workspaceRoot: resolve(options.workspace),
          createWorkspaceRootIfMissing: options.createWorkspace === true,
          ...(selection ? { defaultModelSelection: selection } : {}),
        }),
      );
    });

  project
    .command("icon")
    .description("set or clear a project icon shown in the T3 sidebar")
    .requiredOption("--project <ref>", "project id, id prefix, or exact title")
    .option("--path <file>", "image file: avif, gif, ico, jpg, jpeg, png, svg, or webp")
    .option("--clear", "remove the project icon")
    .action(async (options) => {
      if (Boolean(options.path) === (options.clear === true)) {
        throw new Error("Pass exactly one of --path or --clear.");
      }
      let iconPath: string | null = null;
      if (options.path) {
        iconPath = resolve(options.path);
        if (!(await fileExists(iconPath))) {
          throw new Error(`Project icon '${iconPath}' was not found.`);
        }
      }
      emit(
        "project.icon",
        await new FleetManager(await resolveEnvironment(globals().environment)).setProjectIcon({
          project: options.project,
          iconPath,
        }),
      );
    });

  project
    .command("rename")
    .description("change a project's title, its workspace root, or both")
    .requiredOption("--project <ref>", "project id, id prefix, or exact title")
    .option("--title <title>", "new project title")
    .option("--root <dir>", "new workspace root directory")
    .action(async (options) => {
      if (!options.title && !options.root) {
        throw new Error("Pass --title, --root, or both.");
      }
      let workspaceRoot: string | undefined;
      if (options.root) {
        workspaceRoot = resolve(options.root);
        if (!(await fileExists(workspaceRoot))) {
          throw new Error(`Workspace root '${workspaceRoot}' was not found.`);
        }
      }
      emit(
        "project.rename",
        await new FleetManager(await resolveEnvironment(globals().environment)).renameProject({
          project: options.project,
          ...(options.title ? { title: options.title as string } : {}),
          ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        }),
      );
    });

  const environment = program.command("environment").alias("env");
  environment.command("list").action(async () => emit("environment.list", await config.load()));
  environment
    .command("add")
    .argument("<name>")
    .requiredOption("--url <url>")
    .option("--token-stdin")
    .option("--pairing-stdin")
    .option("--token-file <path>")
    .option("--insecure", "allow plaintext HTTP to a non-loopback T3 server")
    .option("--default", "make this the default environment")
    .action(async (name, options) => {
      if (options.insecure === true && isInsecureT3Url(options.url)) {
        writeErr(
          "warning: --insecure sends T3 credentials over plaintext HTTP/WS; use only on a trusted local network.\n",
        );
      }
      const bearerToken = await tokenFromInput(options, readStdin);
      const probe = createT3Client({
        baseUrl: options.url,
        bearerToken,
        allowInsecure: options.insecure === true,
      });
      const descriptor = (await probe.descriptor()) as { environmentId?: string; label?: string };
      await probe.shell();
      emit(
        "environment.add",
        await config.addEnvironment(name, {
          baseUrl: options.url,
          bearerToken,
          descriptor,
          makeDefault: options.default === true,
          insecure: options.insecure === true,
        }),
      );
    });
  environment
    .command("default")
    .argument("<name>")
    .action(async (name) => {
      await config.setDefault(name);
      emit("environment.default", { name });
    });
  environment
    .command("local-refresh")
    .argument("<name>")
    .requiredOption("--t3-cli <absolute-path>")
    .requiredOption("--base-dir <absolute-path>")
    .option("--before-days <days>", "refresh this many days before expiry", "7")
    .action(async (name, options) => {
      const beforeDays = Number(options.beforeDays);
      if (!Number.isFinite(beforeDays)) throw new Error("--before-days must be a number.");
      emit(
        "environment.local-refresh",
        await config.setLocalRefresh(name, {
          t3Cli: options.t3Cli,
          baseDir: options.baseDir,
          refreshBeforeSeconds: Math.round(beforeDays * 24 * 60 * 60),
        }),
      );
    });
  environment
    .command("refresh")
    .argument("<name>")
    .action(async (name) => {
      const refreshed = await config.refreshEnvironment(name);
      emit("environment.refresh", {
        name,
        credentialExpiresAt: refreshed.config.credentialExpiresAt ?? null,
        lastRefreshedAt: refreshed.config.lastRefreshedAt ?? null,
      });
    });
  environment
    .command("remove")
    .argument("<name>")
    .action(async (name) => {
      await config.removeEnvironment(name);
      emit("environment.remove", { name });
    });

  const schedule = program.command("schedule").description("manage durable T3 turns");
  const scheduleOptions = (command: Command) =>
    command
      .argument("<key>")
      .option("--at <rfc3339>")
      .option("--cron <expression>")
      .option("--timezone <iana-zone>")
      .option("--until <rfc3339>", "last instant a cron schedule may fire; auto-disables after")
      .option("--thread <id>")
      .option("--project <id>")
      .option("--new-thread <title>")
      .option("--provider <instance>")
      .option("--model <slug>")
      .option("--option <id=value>", "live provider model option", collect, [])
      .option("--effort <value>")
      .addOption(new Option("--runtime-mode <mode>").default("full-access"))
      .addOption(new Option("--interaction-mode <mode>").default("default"))
      .option("--worktree")
      .option("--base-branch <branch>", "managed worktree base branch", "main")
      .option("--start-from-origin")
      .option("--prompt <text>")
      .option("--prompt-file <path>")
      .option("--misfire <policy>", "latest or skip", "latest")
      .option("--when-busy <policy>", "defer or skip", "defer")
      .option("--disabled")
      .option("--expected-revision <revision>");

  async function scheduleRequest(
    key: string,
    options: ScheduleCliOptions,
  ): Promise<ScheduleRequest> {
    const environment = await environmentName();
    let target: ScheduleRequest["target"];
    if (options.thread) {
      if (
        options.project ||
        options.newThread ||
        options.provider ||
        options.model ||
        options.effort ||
        options.option.length > 0
      ) {
        throw new Error(
          "Existing-thread schedules use the thread's live route; remove new-thread/provider flags.",
        );
      }
      target = { kind: "existing-thread", threadId: options.thread };
    } else {
      if (!options.project || !options.newThread || !options.provider || !options.model) {
        throw new Error(
          "New-thread schedules require --project, --new-thread, --provider, and --model.",
        );
      }
      const selection: ModelSelection = {
        instanceId: options.provider,
        model: options.model,
        options: explicitOptions(options.option),
      };
      if (options.effort) {
        selection.options?.push(
          effortOption(
            await (await resolveEnvironment(environment)).catalog(),
            selection,
            options.effort,
          ),
        );
      }
      target = {
        kind: "new-thread",
        projectId: options.project,
        title: options.newThread,
        modelSelection: selection,
        runtimeMode: options.runtimeMode as RuntimeMode,
        interactionMode: options.interactionMode as InteractionMode,
        checkout: options.worktree
          ? {
              kind: "managed-worktree",
              baseBranch: options.baseBranch,
              ...(options.startFromOrigin ? { startFromOrigin: true } : {}),
            }
          : { kind: "project-workspace" },
      };
    }
    return {
      managerId: "chief",
      key,
      environment,
      trigger: triggerFromOptions(options),
      target,
      prompt: await promptText(options, readStdin),
      enabled: options.disabled !== true,
      policy: {
        misfire: options.misfire,
        whenBusy: options.whenBusy,
      },
    };
  }

  scheduleOptions(schedule.command("add")).action(async (key, options) => {
    const request = await scheduleRequest(key, options);
    emit(
      "schedule.add",
      await scheduler.put(request, {
        ...(options.expectedRevision !== undefined
          ? { expectedRevision: Number(options.expectedRevision) }
          : {}),
      }),
    );
  });
  scheduleOptions(schedule.command("validate")).action(async (key, options) => {
    const request = await scheduleRequest(key, options);
    await scheduler.validate(request);
    emit("schedule.validate", { valid: true, request });
  });
  schedule
    .command("list")
    .action(() => emit("schedule.list", scheduler.list({ includeDisabled: true })));
  schedule
    .command("show")
    .argument("<id-or-key>")
    .action((id) => {
      const value = ledger.getSchedule(id);
      if (!value) throw new Error(`Schedule '${id}' was not found.`);
      emit("schedule.show", value);
    });
  schedule
    .command("pause")
    .argument("<id-or-key>")
    .action((id) => emit("schedule.pause", scheduler.pause(id)));
  schedule
    .command("resume")
    .argument("<id-or-key>")
    .action(async (id) => emit("schedule.resume", await scheduler.resume(id)));
  schedule
    .command("remove")
    .argument("<id-or-key>")
    .action((id) => {
      scheduler.remove(id);
      emit("schedule.remove", { id });
    });
  schedule
    .command("run")
    .argument("<id-or-key>")
    .option("--request-id <id>", "idempotency key for the manual run")
    .option("--now <rfc3339>")
    .option("--dry-run")
    .action(async (id, options) =>
      emit(
        "schedule.run",
        await scheduler.runNow(id, {
          requestId: options.requestId ?? crypto.randomUUID(),
          ...(options.now ? { now: options.now } : {}),
          apply: options.dryRun !== true,
        }),
      ),
    );

  const rateLimit = program
    .command("rate-limits")
    .description("inspect and recover exact provider session-limit signals");
  rateLimit
    .command("tick")
    .option("--apply")
    .option("--now <rfc3339>")
    .action(async (options) => {
      const environment = await environmentName();
      emit(
        "rate-limits.tick",
        await rateLimits.tick({
          environment,
          apply: options.apply === true,
          ...(options.now ? { now: options.now } : {}),
        }),
      );
    });
  rateLimit.command("status").action(async () => {
    emit("rate-limits.status", {
      signals: ledger.listRateLimitSignals({ environment: await environmentName() }),
    });
  });

  const maintenanceCommand = program
    .command("maintenance")
    .description("resume turns interrupted by planned T3 maintenance");
  maintenanceCommand.command("capture").action(async () => {
    emit("maintenance.capture", await maintenance.capture(await environmentName()));
  });
  maintenanceCommand
    .command("stopped")
    .option("--at <rfc3339>")
    .action(async (options) => {
      emit("maintenance.stopped", maintenance.markStopped(await environmentName(), options.at));
    });
  maintenanceCommand
    .command("deliver")
    .option("--now <rfc3339>")
    .action(async (options) => {
      emit("maintenance.deliver", await maintenance.deliver(await environmentName(), options.now));
    });
  maintenanceCommand.command("status").action(async () => {
    emit("maintenance.status", maintenance.status(await environmentName()));
  });

  program
    .command("tick")
    .description("reconcile schedules, rate limits, and maintenance recovery")
    .option("--apply")
    .option("--now <rfc3339>")
    .action(async (options) => {
      const environment = await environmentName();
      const now = options.now as string | undefined;
      const results = await Promise.allSettled([
        scheduler.tick({ apply: options.apply === true, ...(now ? { now } : {}) }),
        rateLimits.tick({ environment, apply: options.apply === true, ...(now ? { now } : {}) }),
        options.apply === true
          ? maintenance.deliver(environment, now)
          : Promise.resolve({ apply: false, ...maintenance.status(environment) }),
      ]);
      const componentNames = ["schedules", "rateLimits", "maintenance"] as const;
      const data: Record<string, unknown> = {};
      const failures: string[] = [];
      for (const [index, result] of results.entries()) {
        const name = componentNames[index] as string;
        if (result.status === "fulfilled") data[name] = result.value;
        else {
          const message =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          data[name] = { ok: false, error: message };
          failures.push(`${name}: ${message}`);
        }
      }
      emit("tick", { ok: failures.length === 0, ...data });
      if (failures.length > 0) throw new Error(`Supervisor tick failed: ${failures.join("; ")}`);
    });
  schedule
    .command("occurrences")
    .option("--schedule <id-or-key>")
    .action((options) => {
      const selected = options.schedule ? ledger.getSchedule(options.schedule) : null;
      emit(
        "schedule.occurrences",
        ledger.listOccurrences(selected ? { scheduleId: selected.id } : {}),
      );
    });
  schedule
    .command("tick")
    .option("--apply")
    .option("--now <rfc3339>")
    .action(async (options) =>
      emit(
        "schedule.tick",
        await scheduler.tick({
          apply: options.apply === true,
          ...(options.now ? { now: options.now } : {}),
        }),
      ),
    );

  async function unifiedJobs(includeCommands = false) {
    const host = await hostJobs.list();
    const scheduleJobs = scheduler.list({ includeDisabled: true }).map((item) => ({
      ref: `t3:${item.key}`,
      source: "t3chief",
      id: item.id,
      label: item.key,
      enabled: item.enabled,
      schedule:
        item.trigger.kind === "once"
          ? `at ${item.trigger.at}`
          : `${item.trigger.expression} (${item.trigger.timeZone})${item.trigger.until ? ` until ${item.trigger.until}` : ""}`,
      capabilities: ["enable", "disable", "run"],
      tags: ["t3", "scheduled-turn"],
    }));
    return {
      jobs: [...scheduleJobs, ...(includeCommands ? host.jobs : redactCronCommands(host.jobs))],
      warnings: host.warnings,
    };
  }
  program
    .command("jobs")
    .description("list T3 schedules, systemd timers, and cron jobs")
    .option("--include-commands", "include local cron command text")
    .action(async (options: { includeCommands?: boolean }) =>
      emit("jobs", await unifiedJobs(options.includeCommands === true)),
    );
  const job = program.command("job");
  for (const action of ["enable", "disable", "run"] as const) {
    job
      .command(action)
      .argument("<ref>")
      .option("--request-id <id>")
      .action(async (ref, options) => {
        if (ref.startsWith("t3:")) {
          const key = ref.slice(3);
          const result =
            action === "enable"
              ? await scheduler.resume(key)
              : action === "disable"
                ? scheduler.pause(key)
                : await scheduler.runNow(key, {
                    requestId: options.requestId ?? crypto.randomUUID(),
                  });
          emit(`job.${action}`, result);
        } else {
          emit(`job.${action}`, await hostJobs.manage(ref, action));
        }
      });
  }

  const host = program.command("host").description("install and inspect the scheduler wake job");
  host
    .command("jobs")
    .option("--include-commands", "include local cron command text")
    .action(async (options: { includeCommands?: boolean }) =>
      emit("jobs", await unifiedJobs(options.includeCommands === true)),
    );
  host
    .command("install")
    .option("--backend <backend>", "systemd-user or cron", "systemd-user")
    .option("--executable <absolute-path>")
    .action(async (options) => {
      const executable = resolve(
        options.executable ?? process.env.T3CHIEF_EXECUTABLE ?? process.argv[1] ?? "t3chief",
      );
      emit(
        "host.install",
        await new SchedulerWakeInstaller().install(options.backend as WakeBackend, executable),
      );
    });
  host
    .command("uninstall")
    .option("--backend <backend>", "systemd-user or cron", "systemd-user")
    .action(async (options) =>
      emit(
        "host.uninstall",
        await new SchedulerWakeInstaller().uninstall(options.backend as WakeBackend),
      ),
    );

  program
    .command("doctor")
    .description("check configuration, T3, ledger, and host jobs")
    .action(async () => {
      const checks: Array<Record<string, unknown>> = [];
      try {
        const client = await resolveEnvironment(globals().environment);
        const descriptor = await (client as T3V1Client).descriptor?.();
        const shell = (await client.shell()) as { projects?: unknown[]; threads?: unknown[] };
        const providerCatalog = await client.catalog();
        checks.push({
          name: "t3",
          ok: true,
          descriptor: descriptor ?? null,
          projects: shell.projects?.length ?? 0,
          threads: shell.threads?.length ?? 0,
          providers: providerCatalog.providers.length,
        });
      } catch (error) {
        checks.push({
          name: "t3",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const inventory = await unifiedJobs();
      checks.push({
        name: "ledger",
        ok: true,
        schedules: scheduler.list({ includeDisabled: true }).length,
        rateLimitSignals: ledger.listRateLimitSignals().length,
        maintenanceWindows: ledger.listMaintenanceWindows().length,
      });
      checks.push({
        name: "host-jobs",
        ok: inventory.warnings.length === 0,
        warnings: inventory.warnings,
      });
      emit("doctor", { ok: checks.every((check) => check.ok === true), checks });
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (
      error instanceof CommanderError &&
      ["commander.helpDisplayed", "commander.version"].includes(error.code)
    ) {
      return 0;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (argv.includes("--json")) {
      writeErr(
        `${JSON.stringify({ version: 1, ok: false, error: { code: "COMMAND_FAILED", message } })}\n`,
      );
    } else {
      writeErr(`t3chief: ${message}\n`);
    }
    return error instanceof CommanderError ? error.exitCode : 1;
  } finally {
    ownedLedger?.close();
  }
}
