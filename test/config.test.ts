import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "../src/adapters/t3-v1.ts";
import {
  type CommandRunner,
  ConfigStore,
  exchangePairingCredential,
  sessionTokenExpiresAt,
} from "../src/config.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected promise to reject.");
}

describe("configuration", () => {
  function token(expiresAt: string): string {
    const claims = Buffer.from(
      JSON.stringify({ v: 1, kind: "session", exp: Date.parse(expiresAt) }),
    ).toString("base64url");
    return `${claims}.signature`;
  }

  test("stores Claude quota profiles as an absolute token command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3chief-config-"));
    directories.push(directory);
    const store = new ConfigStore({ configDirectory: directory });

    await store.setClaudeProfile({ name: "work", tokenCommand: ["/opt/token", "work"] });
    await store.setClaudeProfile({ name: "personal", tokenCommand: ["/opt/token", "personal"] });
    await store.setClaudeProfile({ name: "work", tokenCommand: ["/opt/token", "one"] });

    expect(await store.listClaudeProfiles()).toEqual([
      { name: "personal", tokenCommand: ["/opt/token", "personal"] },
      { name: "work", tokenCommand: ["/opt/token", "one"] },
    ]);

    await store.removeClaudeProfile("work");
    expect(await store.listClaudeProfiles()).toEqual([
      { name: "personal", tokenCommand: ["/opt/token", "personal"] },
    ]);
    expect(store.removeClaudeProfile("work")).rejects.toThrow("is not configured");
    expect(
      store.setClaudeProfile({ name: "relative", tokenCommand: ["token.sh"] }),
    ).rejects.toThrow("absolute executable path");
    expect(store.setClaudeProfile({ name: "no command", tokenCommand: [] })).rejects.toThrow(
      "1-64 letters",
    );
  });

  test("stores bearer credentials outside the config with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3chief-config-"));
    directories.push(directory);
    const store = new ConfigStore({ configDirectory: directory });

    await store.addEnvironment("home", {
      baseUrl: "http://127.0.0.1:3787/",
      bearerToken: "super-secret",
      descriptor: { environmentId: "env-1", label: "home" },
      makeDefault: true,
    });

    const config = await store.load();
    const credentialPath = config.environments.home?.credentialFile;
    expect(config.defaultEnvironment).toBe("home");
    expect(JSON.stringify(config)).not.toContain("super-secret");
    expect(await readFile(credentialPath as string, "utf8")).toBe("super-secret");
    expect((await stat(credentialPath as string)).mode & 0o777).toBe(0o600);
  });

  test("atomically replaces a credential symlink without following it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3chief-config-"));
    directories.push(directory);
    const credentials = join(directory, "credentials");
    const victim = join(directory, "victim.txt");
    const credential = join(credentials, "home.token");
    await mkdir(credentials);
    await writeFile(victim, "do-not-touch");
    await symlink(victim, credential);

    const store = new ConfigStore({ configDirectory: directory });
    await store.addEnvironment("home", {
      baseUrl: "http://127.0.0.1:3787",
      bearerToken: "new-token",
    });

    expect(await readFile(victim, "utf8")).toBe("do-not-touch");
    expect((await lstat(credential)).isSymbolicLink()).toBe(false);
    expect(await readFile(credential, "utf8")).toBe("new-token");
  });

  test("refuses a symlinked credential directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3chief-config-"));
    const outside = await mkdtemp(join(tmpdir(), "t3chief-credentials-"));
    directories.push(directory, outside);
    await symlink(outside, join(directory, "credentials"));
    const store = new ConfigStore({ configDirectory: directory });

    expect(
      store.addEnvironment("home", {
        baseUrl: "http://127.0.0.1:3787",
        bearerToken: "new-token",
      }),
    ).rejects.toThrow("must not be a symbolic link");
    expect(access(join(outside, "home.token"))).rejects.toThrow();
  });

  test("exchanges a one-time pairing credential for narrow read/operate scopes", async () => {
    let request: RequestInit | undefined;
    const fetcher: FetchLike = async (_input, init) => {
      request = init;
      return Response.json({ access_token: "bearer", token_type: "Bearer", expires_in: 3600 });
    };

    const result = await exchangePairingCredential({
      baseUrl: "https://t3.example",
      pairingCredential: "one-time",
      fetcher,
    });

    const body = new URLSearchParams(String(request?.body));
    expect(result.accessToken).toBe("bearer");
    expect(body.get("scope")).toBe("orchestration:read orchestration:operate");
    expect(body.get("subject_token")).toBe("one-time");
  });

  test("requires TLS away from loopback unless explicitly overridden", async () => {
    let calls = 0;
    const fetcher: FetchLike = async () => {
      calls += 1;
      return Response.json({ access_token: "bearer" });
    };

    expect(
      exchangePairingCredential({
        baseUrl: "http://t3.example",
        pairingCredential: "one-time",
        fetcher,
      }),
    ).rejects.toThrow("requires HTTPS");
    expect(calls).toBe(0);

    const result = await exchangePairingCredential({
      baseUrl: "http://t3.example",
      pairingCredential: "one-time",
      fetcher,
      allowInsecure: true,
    });
    expect(result.accessToken).toBe("bearer");
    expect(calls).toBe(1);
  });

  test("reports only whitelisted OAuth error fields", async () => {
    const sentinel = "PAIRING_SENTINEL_SECRET";
    const fetcher: FetchLike = async () =>
      Response.json(
        {
          error: "invalid_grant",
          error_description: sentinel,
          access_token: sentinel,
        },
        { status: 400 },
      );

    const failure = await captureError(
      exchangePairingCredential({
        baseUrl: "https://t3.example",
        pairingCredential: "one-time",
        fetcher,
      }),
    );

    expect(failure.message).toContain("HTTP 400 (invalid_grant)");
    expect(failure.message).not.toContain(sentinel);
  });

  test("removes the credential file with its environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3chief-config-"));
    directories.push(directory);
    const store = new ConfigStore({ configDirectory: directory });
    const environment = await store.addEnvironment("home", {
      baseUrl: "http://127.0.0.1:3787/",
      bearerToken: "super-secret",
    });

    await store.removeEnvironment("home");

    expect((await store.load()).environments).toEqual({});
    expect(access(environment.credentialFile)).rejects.toThrow();
  });

  test("reads a session expiry without exposing or trusting its signature", () => {
    expect(sessionTokenExpiresAt(token("2030-09-26T13:00:00.000Z"))).toBe(
      "2030-09-26T13:00:00.000Z",
    );
    expect(sessionTokenExpiresAt("opaque-token")).toBeNull();
  });

  test("refreshes a near-expiry local session through a one-time narrow pairing exchange", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3chief-config-"));
    directories.push(directory);
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return {
        exitCode: 0,
        stdout: JSON.stringify({ credential: "one-time-secret" }),
        stderr: "",
      };
    };
    const fetcher: FetchLike = async (_input, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("scope")).toBe("orchestration:read orchestration:operate");
      expect(body.get("subject_token")).toBe("one-time-secret");
      return Response.json({
        access_token: token("2030-10-27T00:00:00.000Z"),
        token_type: "Bearer",
        expires_in: 2_592_000,
      });
    };
    const store = new ConfigStore({
      configDirectory: directory,
      runCommand: runner,
      fetcher,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });
    await store.addEnvironment("home", {
      baseUrl: "http://127.0.0.1:3787",
      bearerToken: token("2030-01-02T00:00:00.000Z"),
      makeDefault: true,
    });
    await store.setLocalRefresh("home", {
      t3Cli: "/opt/t3/bin.mjs",
      baseDir: "/srv/t3",
      refreshBeforeSeconds: 7 * 24 * 60 * 60,
    });

    const [resolved, concurrent] = await Promise.all([
      store.resolveEnvironment("home"),
      store.resolveEnvironment("home"),
    ]);
    const rawConfig = await readFile(join(directory, "config.json"), "utf8");

    expect(resolved.bearerToken).toBe(token("2030-10-27T00:00:00.000Z"));
    expect(concurrent.bearerToken).toBe(resolved.bearerToken);
    expect(calls).toEqual([
      {
        command: "/opt/t3/bin.mjs",
        args: [
          "auth",
          "pairing",
          "create",
          "--base-dir",
          "/srv/t3",
          "--ttl",
          "5m",
          "--label",
          "t3-chief-refresh",
          "--json",
        ],
      },
    ]);
    expect(rawConfig).not.toContain("one-time-secret");
    expect(rawConfig).not.toContain(resolved.bearerToken);
  });

  test("does not expose local pairing command stderr", async () => {
    const directory = await mkdtemp(join(tmpdir(), "t3chief-config-"));
    directories.push(directory);
    const sentinel = "LOCAL_PAIRING_SENTINEL_SECRET";
    const store = new ConfigStore({
      configDirectory: directory,
      runCommand: async () => ({ exitCode: 17, stdout: "", stderr: sentinel }),
    });
    await store.addEnvironment("home", {
      baseUrl: "http://127.0.0.1:3787",
      bearerToken: "token",
    });
    await store.setLocalRefresh("home", {
      t3Cli: "/opt/t3/bin.mjs",
      baseDir: "/srv/t3",
      refreshBeforeSeconds: 7 * 24 * 60 * 60,
    });

    const failure = await captureError(store.refreshEnvironment("home"));

    expect(failure.message).toContain("exit 17");
    expect(failure.message).not.toContain(sentinel);
  });
});
