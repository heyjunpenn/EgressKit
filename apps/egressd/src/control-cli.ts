export interface ControlCliClient {
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>>;
}

export interface ControlCliIo {
  readStdin(): Promise<string>;
  write(value: string): void;
}

export async function runControlCli(
  arguments_: readonly string[],
  io: ControlCliIo,
  client: ControlCliClient,
): Promise<void> {
  const [resource, action, identifier] = arguments_.filter((value) => !value.startsWith("--"));
  const redact = arguments_.includes("--redact");
  if (resource === "subscription" && action === "add") {
    const argumentUrl = identifier;
    const url = (argumentUrl ?? (await io.readStdin())).trim();
    if (!url) {
      throw new Error("subscription URL is required as an argument or standard input");
    }
    new URL(url);
    const created = await client.request("POST", "/subscriptions/remote", { url });
    if (arguments_.includes("--async")) {
      writeJson(io, created);
      return;
    }
    const operationId = requiredString(created, "operationId");
    const subscriptionId = requiredString(created, "subscriptionId");
    let operation: Record<string, unknown>;
    do {
      operation = await client.request("GET", `/operations/${encodeURIComponent(operationId)}`);
      if (!isTerminalOperation(operation.status)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    } while (!isTerminalOperation(operation.status));
    if (operation.status !== "succeeded") {
      writeJson(io, operation);
      throw new Error(`operation ${operationId} ${String(operation.status)}`);
    }
    const subscription = await client.request(
      "GET",
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    );
    writeJson(io, redactObject(subscription, redact));
    return;
  }
  if (resource === "subscription" && action === "get" && identifier) {
    const subscription = await client.request(
      "GET",
      `/subscriptions/${encodeURIComponent(identifier)}`,
    );
    writeJson(io, redactObject(subscription, redact));
    return;
  }
  if (resource === "operation" && action === "get" && identifier) {
    writeJson(io, await client.request("GET", `/operations/${encodeURIComponent(identifier)}`));
    return;
  }
  throw new Error(
    "usage: egresskit subscription add [URL] [--async] [--redact] | subscription get ID [--redact] | operation get ID",
  );
}

function redactObject(value: Record<string, unknown>, redact: boolean): Record<string, unknown> {
  if (!redact || typeof value.url !== "string") {
    return value;
  }
  return { ...value, url: redactSubscriptionUrl(value.url) };
}

export function redactSubscriptionUrl(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}/[redacted]`;
}

function isTerminalOperation(value: unknown): boolean {
  return value === "succeeded" || value === "failed" || value === "interrupted";
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string") {
    throw new Error(`daemon response is missing ${field}`);
  }
  return result;
}

function writeJson(io: ControlCliIo, value: Record<string, unknown>): void {
  io.write(`${JSON.stringify(value, undefined, 2)}\n`);
}
