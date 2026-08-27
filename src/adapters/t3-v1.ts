import { createHash } from "node:crypto";

export interface RpcTransport {
  request(tag: string, payload: unknown): Promise<unknown>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ModelOptionValue = string | number | boolean;

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: Array<{ id: string; value: ModelOptionValue }>;
}

export interface OptionDescriptor {
  id: string;
  label: string;
  type: string;
  options?: Array<{ id: string; label?: string; isDefault?: boolean }>;
  currentValue?: ModelOptionValue;
}

export interface CatalogModel {
  slug: string;
  name: string;
  isDefault: boolean;
  optionDescriptors: OptionDescriptor[];
}

export interface CatalogProvider {
  instanceId: string;
  driver: string;
  status: string;
  enabled?: boolean;
  installed?: boolean;
  availability?: string;
  authStatus?: string;
  message?: string;
  models: CatalogModel[];
}

export interface ProviderCatalog {
  observedAt: string;
  fingerprint: string;
  providers: CatalogProvider[];
}

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface T3ClientOptions {
  baseUrl: string;
  bearerToken: string;
  allowInsecure?: boolean;
  fetcher?: FetchLike;
  rpc?: RpcTransport;
  timeoutMs?: number;
}

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".").map(Number);
  return octets.length === 4 && octets.every(Number.isInteger) && octets[0] === 127;
}

export function isInsecureT3Url(baseUrl: string): boolean {
  const url = new URL(baseUrl);
  return url.protocol === "http:" && !loopbackHostname(url.hostname);
}

export function normalizeT3BaseUrl(
  baseUrl: string,
  options: { allowInsecure?: boolean } = {},
): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("T3 URLs must use HTTPS, or HTTP for a loopback server.");
  }
  if (isInsecureT3Url(url.toString()) && options.allowInsecure !== true) {
    throw new Error(
      "A non-loopback T3 URL requires HTTPS (and therefore WSS); pass --insecure only for a trusted local network.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

export class T3HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(message);
    this.name = "T3HttpError";
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  let detail: unknown = text;
  try {
    detail = text.length === 0 ? null : JSON.parse(text);
  } catch {
    // Keep non-JSON error bodies intact for diagnostics.
  }
  if (!response.ok) {
    throw new T3HttpError(
      `T3 request failed with HTTP ${response.status}.`,
      response.status,
      detail,
    );
  }
  return detail;
}

function normalizeConfig(value: unknown): ProviderCatalog {
  const record = value as { providers?: unknown[] };
  const providers = (record.providers ?? []).map((providerValue) => {
    const provider = providerValue as Record<string, unknown>;
    const auth = (provider.auth ?? {}) as Record<string, unknown>;
    const models = Array.isArray(provider.models) ? provider.models : [];
    return {
      instanceId: String(provider.instanceId ?? ""),
      driver: String(provider.driver ?? ""),
      status: String(provider.status ?? "unknown"),
      enabled: provider.enabled !== false,
      installed: provider.installed !== false,
      availability: String(provider.availability ?? "available"),
      authStatus: String(auth.status ?? "unknown"),
      ...(typeof provider.message === "string" ? { message: provider.message } : {}),
      models: models.map((modelValue) => {
        const model = modelValue as Record<string, unknown>;
        const capabilities = (model.capabilities ?? {}) as Record<string, unknown>;
        const descriptors = Array.isArray(capabilities.optionDescriptors)
          ? capabilities.optionDescriptors
          : [];
        return {
          slug: String(model.slug ?? ""),
          name: String(model.name ?? model.slug ?? ""),
          isDefault: model.isDefault === true,
          optionDescriptors: descriptors.map((descriptorValue) => {
            const descriptor = descriptorValue as Record<string, unknown>;
            const options = Array.isArray(descriptor.options) ? descriptor.options : undefined;
            return {
              id: String(descriptor.id ?? ""),
              label: String(descriptor.label ?? descriptor.id ?? ""),
              type: String(descriptor.type ?? "unknown"),
              ...(options
                ? {
                    options: options.map((optionValue) => {
                      const option = optionValue as Record<string, unknown>;
                      return {
                        id: String(option.id ?? ""),
                        ...(typeof option.label === "string" ? { label: option.label } : {}),
                        ...(option.isDefault === true ? { isDefault: true } : {}),
                      };
                    }),
                  }
                : {}),
              ...(typeof descriptor.currentValue === "string" ||
              typeof descriptor.currentValue === "number" ||
              typeof descriptor.currentValue === "boolean"
                ? { currentValue: descriptor.currentValue }
                : {}),
            } satisfies OptionDescriptor;
          }),
        } satisfies CatalogModel;
      }),
    } satisfies CatalogProvider;
  });
  return {
    observedAt: new Date().toISOString(),
    fingerprint: createHash("sha256").update(canonical(providers)).digest("hex"),
    providers,
  };
}

export function validateModelSelection(
  catalog: ProviderCatalog,
  selection: ModelSelection,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const provider = catalog.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  if (!provider) {
    return [
      {
        code: "PROVIDER_NOT_FOUND",
        path: "modelSelection.instanceId",
        message: `Provider instance '${selection.instanceId}' is not advertised by T3.`,
      },
    ];
  }
  if (provider.enabled === false) {
    issues.push({
      code: "PROVIDER_DISABLED",
      path: "modelSelection.instanceId",
      message: `Provider instance '${selection.instanceId}' is disabled.`,
    });
  }
  if (provider.installed === false) {
    issues.push({
      code: "PROVIDER_NOT_INSTALLED",
      path: "modelSelection.instanceId",
      message: `Provider instance '${selection.instanceId}' is not installed.`,
    });
  }
  if (provider.availability === "unavailable") {
    issues.push({
      code: "PROVIDER_UNAVAILABLE",
      path: "modelSelection.instanceId",
      message: `Provider instance '${selection.instanceId}' is unavailable in this T3 build.`,
    });
  }
  if (provider.status !== "ready") {
    issues.push({
      code: "PROVIDER_NOT_READY",
      path: "modelSelection.instanceId",
      message: `Provider instance '${selection.instanceId}' has status '${provider.status}'.`,
    });
  }
  if (provider.authStatus === "unauthenticated") {
    issues.push({
      code: "PROVIDER_UNAUTHENTICATED",
      path: "modelSelection.instanceId",
      message: `Provider instance '${selection.instanceId}' is not authenticated.`,
    });
  }
  const model = provider.models.find((candidate) => candidate.slug === selection.model);
  if (!model) {
    issues.push({
      code: "MODEL_NOT_FOUND",
      path: "modelSelection.model",
      message: `Model '${selection.model}' is not advertised by '${selection.instanceId}'.`,
    });
    return issues;
  }

  const seen = new Set<string>();
  for (const [index, option] of (selection.options ?? []).entries()) {
    const path = `modelSelection.options[${index}]`;
    if (seen.has(option.id)) {
      issues.push({
        code: "OPTION_DUPLICATE",
        path,
        message: `Option '${option.id}' is duplicated.`,
      });
      continue;
    }
    seen.add(option.id);
    const descriptor = model.optionDescriptors.find((candidate) => candidate.id === option.id);
    if (!descriptor) {
      issues.push({
        code: "OPTION_NOT_FOUND",
        path,
        message: `Option '${option.id}' is not advertised for '${selection.model}'.`,
      });
      continue;
    }
    if (
      descriptor.type === "select" &&
      !descriptor.options?.some((candidate) => candidate.id === option.value)
    ) {
      issues.push({
        code: "OPTION_VALUE_INVALID",
        path,
        message: `Value '${String(option.value)}' is not allowed for '${option.id}'.`,
      });
    } else if (descriptor.type === "boolean" && typeof option.value !== "boolean") {
      issues.push({
        code: "OPTION_VALUE_INVALID",
        path,
        message: `Option '${option.id}' requires a boolean value.`,
      });
    }
  }
  return issues;
}

class WebSocketRpcTransport implements RpcTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly bearerToken: string,
    private readonly fetcher: FetchLike,
    private readonly timeoutMs: number,
  ) {}

  async request(tag: string, payload: unknown): Promise<unknown> {
    const ticketResponse = await this.fetcher(new URL("/api/auth/websocket-ticket", this.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.bearerToken}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const ticketResult = (await responseJson(ticketResponse)) as { ticket?: string };
    if (!ticketResult.ticket) throw new Error("T3 did not return a WebSocket ticket.");

    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "";
    url.searchParams.set("wsTicket", ticketResult.ticket);

    return await new Promise<unknown>((resolve, reject) => {
      const socket = new WebSocket(url);
      const requestId = "1";
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`T3 RPC '${tag}' timed out.`));
      }, this.timeoutMs);
      const finish = (callback: () => void) => {
        clearTimeout(timeout);
        socket.close();
        callback();
      };
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ _tag: "Ping" }));
        socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
      });
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (frame._tag !== "Exit" || frame.requestId !== requestId) return;
        const exit = frame.exit as Record<string, unknown>;
        if (exit._tag === "Success") {
          finish(() => resolve(exit.value));
        } else {
          const cause = exit.cause as { _tag?: unknown; code?: unknown } | null;
          const causeTag =
            typeof cause?._tag === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(cause._tag)
              ? `, tag=${cause._tag}`
              : "";
          const causeCode =
            typeof cause?.code === "number" && Number.isSafeInteger(cause.code)
              ? `, code=${cause.code}`
              : "";
          finish(() => reject(new Error(`T3 RPC '${tag}' failed${causeTag}${causeCode}.`)));
        }
      });
      socket.addEventListener("error", () =>
        finish(() => reject(new Error(`T3 RPC '${tag}' WebSocket failed.`))),
      );
    });
  }
}

export class T3V1Client {
  readonly baseUrl: string;
  private readonly bearerToken: string;
  private readonly fetcher: FetchLike;
  private readonly rpc: RpcTransport;
  private readonly timeoutMs: number;

  constructor(options: T3ClientOptions) {
    this.baseUrl = normalizeT3BaseUrl(options.baseUrl, {
      allowInsecure: options.allowInsecure === true,
    });
    this.bearerToken = options.bearerToken;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.rpc =
      options.rpc ??
      new WebSocketRpcTransport(this.baseUrl, this.bearerToken, this.fetcher, this.timeoutMs);
  }

  private async get(path: string): Promise<unknown> {
    const response = await this.fetcher(new URL(path, `${this.baseUrl}/`), {
      headers: { authorization: `Bearer ${this.bearerToken}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return responseJson(response);
  }

  async descriptor(): Promise<unknown> {
    const response = await this.fetcher(
      new URL("/.well-known/t3/environment", `${this.baseUrl}/`),
      {
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    return responseJson(response);
  }

  async shell(): Promise<unknown> {
    return this.get("/api/orchestration/shell");
  }

  async thread(
    threadId: string,
    options: { turnLimit?: number; beforeCursor?: string } = {},
  ): Promise<unknown> {
    const path = new URL(
      `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
      `${this.baseUrl}/`,
    );
    if (options.turnLimit !== undefined)
      path.searchParams.set("turnLimit", String(options.turnLimit));
    if (options.beforeCursor) path.searchParams.set("beforeCursor", options.beforeCursor);
    return this.get(`${path.pathname}${path.search}`);
  }

  async catalog(): Promise<ProviderCatalog> {
    return normalizeConfig(await this.rpc.request("server.getConfig", {}));
  }

  async dispatch(command: Record<string, unknown>): Promise<unknown> {
    return this.rpc.request("orchestration.dispatchCommand", command);
  }
}
