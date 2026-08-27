import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { type FetchLike, normalizeT3BaseUrl, T3V1Client } from "./adapters/t3-v1.ts";

export interface EnvironmentConfig {
  baseUrl: string;
  credentialFile: string;
  credentialExpiresAt?: string;
  lastRefreshedAt?: string;
  environmentId?: string;
  label?: string;
  insecure?: boolean;
  localRefresh?: LocalRefreshConfig;
}

export interface LocalRefreshConfig {
  t3Cli: string;
  baseDir: string;
  refreshBeforeSeconds: number;
}

/**
 * How to obtain an OAuth token for one Claude account. The command must print the token on
 * stdout; t3chief never stores it, never passes it as an argument, and never logs it.
 */
export interface ClaudeProfileConfig {
  name: string;
  tokenCommand: string[];
}

export interface T3ChiefConfig {
  version: 1;
  defaultEnvironment: string | null;
  environments: Record<string, EnvironmentConfig>;
  /** Host-level, not per-environment: Claude quota belongs to the account, not to a T3 server. */
  claudeProfiles?: ClaudeProfileConfig[];
}

export interface ConfigStoreOptions {
  configDirectory?: string;
  stateDirectory?: string;
  runCommand?: CommandRunner;
  fetcher?: FetchLike;
  now?: () => Date;
}

export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

function defaultConfigDirectory(): string {
  return `${process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? process.cwd(), ".config")}/t3chief`;
}

function defaultStateDirectory(): string {
  return `${process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? process.cwd(), ".local", "state")}/t3chief`;
}

const EMPTY_CONFIG: T3ChiefConfig = {
  version: 1,
  defaultEnvironment: null,
  environments: {},
};

async function ensureCredentialDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Credential directory '${path}' must not be a symbolic link.`);
  }
  if (!metadata.isDirectory()) throw new Error(`Credential path '${path}' is not a directory.`);
  await chmod(path, 0o700);
}

async function atomicWriteCredential(path: string, value: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

export const defaultRunCommand: CommandRunner = async (command, args) =>
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolvePromise({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: timedOut
          ? "T3 CLI timed out after 15 seconds."
          : Buffer.concat(stderr).toString("utf8"),
      });
    });
  });

export function sessionTokenExpiresAt(token: string): string | null {
  const payload = token.split(".")[0];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      kind?: unknown;
      exp?: unknown;
    };
    if (claims.kind !== "session" || typeof claims.exp !== "number") return null;
    const expiresAt = new Date(claims.exp);
    return Number.isFinite(expiresAt.getTime()) ? expiresAt.toISOString() : null;
  } catch {
    return null;
  }
}

export class ConfigStore {
  readonly configDirectory: string;
  readonly stateDirectory: string;
  readonly databasePath: string;
  private readonly configPath: string;
  private readonly runCommand: CommandRunner;
  private readonly fetcher: FetchLike;
  private readonly now: () => Date;
  private readonly refreshes = new Map<
    string,
    Promise<{ config: EnvironmentConfig; bearerToken: string }>
  >();

  constructor(options: ConfigStoreOptions = {}) {
    this.configDirectory = resolve(options.configDirectory ?? defaultConfigDirectory());
    this.stateDirectory = resolve(options.stateDirectory ?? defaultStateDirectory());
    this.databasePath = join(this.stateDirectory, "state.sqlite");
    this.configPath = join(this.configDirectory, "config.json");
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<T3ChiefConfig> {
    try {
      const parsed = JSON.parse(await readFile(this.configPath, "utf8")) as T3ChiefConfig;
      if (parsed.version !== 1 || !parsed.environments) {
        throw new Error(`Unsupported t3chief config at '${this.configPath}'.`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_CONFIG);
      throw error;
    }
  }

  async addEnvironment(
    name: string,
    input: {
      baseUrl: string;
      bearerToken: string;
      descriptor?: { environmentId?: string; label?: string };
      makeDefault?: boolean;
      insecure?: boolean;
    },
  ): Promise<EnvironmentConfig> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
      throw new Error(
        "Environment name must contain 1-64 letters, numbers, dots, underscores, or hyphens.",
      );
    }
    if (input.bearerToken.trim().length === 0) throw new Error("Bearer token cannot be empty.");
    const baseUrl = normalizeT3BaseUrl(input.baseUrl, {
      allowInsecure: input.insecure === true,
    });
    const credentialDirectory = join(this.configDirectory, "credentials");
    await ensureCredentialDirectory(credentialDirectory);
    const credentialFile = join(credentialDirectory, `${name}.token`);
    await atomicWriteCredential(credentialFile, input.bearerToken.trim());
    const config = await this.load();
    const environment: EnvironmentConfig = {
      baseUrl,
      credentialFile,
      ...(sessionTokenExpiresAt(input.bearerToken)
        ? { credentialExpiresAt: sessionTokenExpiresAt(input.bearerToken) as string }
        : {}),
      ...(input.descriptor?.environmentId ? { environmentId: input.descriptor.environmentId } : {}),
      ...(input.descriptor?.label ? { label: input.descriptor.label } : {}),
      ...(input.insecure ? { insecure: true } : {}),
    };
    config.environments[name] = environment;
    if (input.makeDefault || config.defaultEnvironment === null) config.defaultEnvironment = name;
    await this.save(config);
    return environment;
  }

  async listClaudeProfiles(): Promise<ClaudeProfileConfig[]> {
    return (await this.load()).claudeProfiles ?? [];
  }

  async setClaudeProfile(input: ClaudeProfileConfig): Promise<ClaudeProfileConfig[]> {
    const name = input.name.trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
      throw new Error(
        "Claude profile name must contain 1-64 letters, numbers, dots, underscores, or hyphens.",
      );
    }
    const [executable, ...args] = input.tokenCommand;
    if (!executable) throw new Error("A Claude profile needs a token command.");
    if (!isAbsolute(executable)) {
      throw new Error("The Claude token command must be an absolute executable path.");
    }
    const config = await this.load();
    const profiles = (config.claudeProfiles ?? []).filter((profile) => profile.name !== name);
    profiles.push({ name, tokenCommand: [resolve(executable), ...args] });
    profiles.sort((left, right) => left.name.localeCompare(right.name));
    config.claudeProfiles = profiles;
    await this.save(config);
    return profiles;
  }

  async removeClaudeProfile(name: string): Promise<ClaudeProfileConfig[]> {
    const config = await this.load();
    const profiles = config.claudeProfiles ?? [];
    if (!profiles.some((profile) => profile.name === name)) {
      throw new Error(`Claude profile '${name}' is not configured.`);
    }
    config.claudeProfiles = profiles.filter((profile) => profile.name !== name);
    await this.save(config);
    return config.claudeProfiles;
  }

  async setDefault(name: string): Promise<void> {
    const config = await this.load();
    if (!config.environments[name]) throw new Error(`Environment '${name}' is not configured.`);
    config.defaultEnvironment = name;
    await this.save(config);
  }

  async setLocalRefresh(name: string, input: LocalRefreshConfig): Promise<EnvironmentConfig> {
    if (!isAbsolute(input.t3Cli) || !isAbsolute(input.baseDir)) {
      throw new Error("Local refresh requires absolute --t3-cli and --base-dir paths.");
    }
    if (
      !Number.isInteger(input.refreshBeforeSeconds) ||
      input.refreshBeforeSeconds < 3_600 ||
      input.refreshBeforeSeconds > 29 * 24 * 60 * 60
    ) {
      throw new Error("Local refresh lead time must be an integer from 1 hour through 29 days.");
    }
    const config = await this.load();
    const environment = config.environments[name];
    if (!environment) throw new Error(`Environment '${name}' is not configured.`);
    environment.localRefresh = {
      t3Cli: resolve(input.t3Cli),
      baseDir: resolve(input.baseDir),
      refreshBeforeSeconds: input.refreshBeforeSeconds,
    };
    const currentToken = (await readFile(environment.credentialFile, "utf8")).trim();
    const currentExpiry = sessionTokenExpiresAt(currentToken);
    if (currentExpiry) environment.credentialExpiresAt = currentExpiry;
    await this.save(config);
    return environment;
  }

  async removeEnvironment(name: string): Promise<void> {
    const config = await this.load();
    const environment = config.environments[name];
    if (!environment) throw new Error(`Environment '${name}' is not configured.`);
    delete config.environments[name];
    if (config.defaultEnvironment === name) {
      config.defaultEnvironment = Object.keys(config.environments).sort()[0] ?? null;
    }
    await this.save(config);
    try {
      await unlink(environment.credentialFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async resolveEnvironment(name?: string): Promise<{
    name: string;
    config: EnvironmentConfig;
    bearerToken: string;
  }> {
    const config = await this.load();
    const selected = name ?? config.defaultEnvironment;
    if (!selected) throw new Error("No default T3 environment is configured.");
    let environment = config.environments[selected];
    if (!environment) throw new Error(`Environment '${selected}' is not configured.`);
    let bearerToken = (await readFile(environment.credentialFile, "utf8")).trim();
    if (!bearerToken) throw new Error(`Credential file for '${selected}' is empty.`);
    const expiresAt = sessionTokenExpiresAt(bearerToken) ?? environment.credentialExpiresAt;
    if (
      expiresAt &&
      Date.parse(expiresAt) - this.now().getTime() <=
        (environment.localRefresh?.refreshBeforeSeconds ?? 0) * 1_000
    ) {
      if (environment.localRefresh) {
        const refreshed = await this.refreshEnvironment(selected);
        environment = refreshed.config;
        bearerToken = refreshed.bearerToken;
      } else if (Date.parse(expiresAt) <= this.now().getTime()) {
        throw new Error(
          `Credential for '${selected}' expired at ${expiresAt}; pair again or enable local refresh.`,
        );
      }
    }
    return { name: selected, config: environment, bearerToken };
  }

  async refreshEnvironment(name: string): Promise<{
    config: EnvironmentConfig;
    bearerToken: string;
  }> {
    const active = this.refreshes.get(name);
    if (active) return active;
    const refresh = this.performRefresh(name);
    this.refreshes.set(name, refresh);
    try {
      return await refresh;
    } finally {
      if (this.refreshes.get(name) === refresh) this.refreshes.delete(name);
    }
  }

  private async performRefresh(name: string): Promise<{
    config: EnvironmentConfig;
    bearerToken: string;
  }> {
    const root = await this.load();
    const environment = root.environments[name];
    if (!environment) throw new Error(`Environment '${name}' is not configured.`);
    const local = environment.localRefresh;
    if (!local) throw new Error(`Environment '${name}' has no local refresh configuration.`);
    const issued = await this.runCommand(local.t3Cli, [
      "auth",
      "pairing",
      "create",
      "--base-dir",
      local.baseDir,
      "--ttl",
      "5m",
      "--label",
      "t3-chief-refresh",
      "--json",
    ]);
    if (issued.exitCode !== 0) {
      throw new Error(`Could not mint a local T3 pairing credential (exit ${issued.exitCode}).`);
    }
    let pairingCredential: string;
    try {
      const parsed = JSON.parse(issued.stdout) as { credential?: unknown };
      if (typeof parsed.credential !== "string" || parsed.credential.length === 0) {
        throw new Error("missing credential");
      }
      pairingCredential = parsed.credential;
    } catch {
      throw new Error("Local T3 pairing command returned invalid JSON.");
    }
    const exchanged = await exchangePairingCredential({
      baseUrl: environment.baseUrl,
      pairingCredential,
      fetcher: this.fetcher,
      allowInsecure: environment.insecure === true,
    });
    await atomicWriteCredential(environment.credentialFile, exchanged.accessToken);
    const refreshedAt = this.now();
    environment.lastRefreshedAt = refreshedAt.toISOString();
    const credentialExpiresAt =
      sessionTokenExpiresAt(exchanged.accessToken) ??
      (exchanged.expiresIn === null
        ? undefined
        : new Date(refreshedAt.getTime() + exchanged.expiresIn * 1_000).toISOString());
    if (credentialExpiresAt) environment.credentialExpiresAt = credentialExpiresAt;
    else delete environment.credentialExpiresAt;
    await this.save(root);
    return { config: environment, bearerToken: exchanged.accessToken };
  }

  async client(name?: string): Promise<T3V1Client> {
    const resolved = await this.resolveEnvironment(name);
    return new T3V1Client({
      baseUrl: resolved.config.baseUrl,
      bearerToken: resolved.bearerToken,
      allowInsecure: resolved.config.insecure === true,
    });
  }

  async ensureStateDirectory(): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.stateDirectory, 0o700);
  }

  private async save(config: T3ChiefConfig): Promise<void> {
    await mkdir(this.configDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${this.configPath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.configPath);
    await chmod(this.configPath, 0o600);
  }
}

export async function exchangePairingCredential(input: {
  baseUrl: string;
  pairingCredential: string;
  fetcher?: FetchLike;
  timeoutMs?: number;
  allowInsecure?: boolean;
}): Promise<{ accessToken: string; tokenType: string; expiresIn: number | null }> {
  const fetcher = input.fetcher ?? fetch;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: input.pairingCredential,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: "orchestration:read orchestration:operate",
    client_label: "t3-chief",
    client_device_type: "bot",
    client_os: process.platform,
  });
  const baseUrl = normalizeT3BaseUrl(input.baseUrl, {
    allowInsecure: input.allowInsecure === true,
  });
  const response = await fetcher(new URL("/oauth/token", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
  });
  const text = await response.text();
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`T3 pairing returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const oauthError =
      typeof result.error === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(result.error)
        ? ` (${result.error})`
        : "";
    throw new Error(`T3 pairing failed with HTTP ${response.status}${oauthError}.`);
  }
  if (typeof result.access_token !== "string" || result.access_token.length === 0) {
    throw new Error("T3 pairing response did not contain an access token.");
  }
  return {
    accessToken: result.access_token,
    tokenType: typeof result.token_type === "string" ? result.token_type : "Bearer",
    expiresIn: typeof result.expires_in === "number" ? result.expires_in : null,
  };
}
