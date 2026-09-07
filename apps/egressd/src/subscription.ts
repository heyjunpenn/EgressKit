import { parse } from "yaml";

export interface ImportLocalVlessOptions {
  firstListenerPort: number;
}

export interface NormalizedVlessNode {
  name: string;
  type: "vless";
  server: string;
  port: number;
  uuid: string;
  network: "tcp" | "ws" | "grpc";
  tls?: boolean;
  servername?: string;
  flow?: string;
  udp?: boolean;
  "client-fingerprint"?: string;
  "reality-opts"?: { "public-key": string; "short-id"?: string };
  "ws-opts"?: { path?: string; headers?: Record<string, string> };
  "grpc-opts"?: { "grpc-service-name"?: string };
}

export interface MihomoListenerConfig {
  name: string;
  type: "http";
  listen: "127.0.0.1";
  port: number;
  proxy: string;
}

export interface ImportedVlessRevision {
  nodes: NormalizedVlessNode[];
  mihomoConfig: {
    listeners: MihomoListenerConfig[];
    proxies: NormalizedVlessNode[];
  };
}

export function importLocalVlessYaml(
  source: string,
  options: ImportLocalVlessOptions,
): ImportedVlessRevision {
  if (!Number.isInteger(options.firstListenerPort) || options.firstListenerPort < 1) {
    throw new Error("firstListenerPort must be a positive integer");
  }
  const document: unknown = parse(source);
  if (!isRecord(document) || !Array.isArray(document.proxies)) {
    throw new Error("subscription must contain a proxies array");
  }

  const nodes = document.proxies
    .filter((candidate): candidate is Record<string, unknown> => isRecord(candidate))
    .filter((candidate) => candidate.type === "vless")
    .map(normalizeVlessNode);

  const names = new Set<string>();
  for (const node of nodes) {
    if (names.has(node.name)) {
      throw new Error(`duplicate VLESS node name: ${node.name}`);
    }
    names.add(node.name);
  }

  const listeners = nodes.map((node, index) => ({
    name: `egresskit-${node.name}`,
    type: "http" as const,
    listen: "127.0.0.1" as const,
    port: options.firstListenerPort + index,
    proxy: node.name,
  }));
  if (listeners.some((listener) => listener.port > 65_535)) {
    throw new Error("generated listener port exceeds 65535");
  }

  return { nodes, mihomoConfig: { listeners, proxies: nodes } };
}

function normalizeVlessNode(candidate: Record<string, unknown>): NormalizedVlessNode {
  const name = requiredString(candidate, "name");
  const server = requiredString(candidate, "server");
  const uuid = requiredString(candidate, "uuid");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new Error(`VLESS node ${name} has an invalid uuid`);
  }
  const port = candidate.port;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    throw new Error(`VLESS node ${name} has an invalid port`);
  }

  const network = candidate.network ?? "tcp";
  if (network !== "tcp" && network !== "ws" && network !== "grpc") {
    throw new Error(`VLESS node ${name} uses unsupported transport: ${String(network)}`);
  }
  if (candidate["ws-opts"] !== undefined && network !== "ws") {
    throw new Error(`VLESS node ${name}: ws-opts requires the ws transport`);
  }
  if (candidate["grpc-opts"] !== undefined && network !== "grpc") {
    throw new Error(`VLESS node ${name}: grpc-opts requires the grpc transport`);
  }
  if (candidate.flow !== undefined && network !== "tcp") {
    throw new Error(`VLESS node ${name}: flow requires the tcp transport`);
  }
  if (candidate["reality-opts"] !== undefined && candidate.tls !== true) {
    throw new Error(`VLESS node ${name}: reality-opts requires tls`);
  }

  return {
    name,
    type: "vless",
    server,
    port: port as number,
    uuid,
    network,
    ...optionalBoolean(candidate, "tls"),
    ...optionalString(candidate, "servername"),
    ...optionalString(candidate, "flow"),
    ...optionalBoolean(candidate, "udp"),
    ...optionalString(candidate, "client-fingerprint"),
    ...(network === "ws" ? optionalWsOptions(candidate["ws-opts"]) : {}),
    ...(network === "grpc" ? optionalGrpcOptions(candidate["grpc-opts"]) : {}),
    ...optionalRealityOptions(candidate["reality-opts"]),
  };
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`VLESS node is missing required field: ${key}`);
  }
  return value;
}

function optionalString<K extends string>(
  record: Record<string, unknown>,
  key: K,
): Partial<Record<K, string>> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string") {
    throw new Error(`VLESS field ${key} must be a string`);
  }
  return { [key]: value } as Partial<Record<K, string>>;
}

function optionalBoolean<K extends string>(
  record: Record<string, unknown>,
  key: K,
): Partial<Record<K, boolean>> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "boolean") {
    throw new Error(`VLESS field ${key} must be a boolean`);
  }
  return { [key]: value } as Partial<Record<K, boolean>>;
}

function optionalWsOptions(value: unknown): Pick<NormalizedVlessNode, "ws-opts"> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("VLESS ws-opts must be an object");
  }
  if (
    isRecord(value.headers) &&
    Object.values(value.headers).some((header) => typeof header !== "string")
  ) {
    throw new Error("VLESS ws-opts headers must contain strings");
  }
  const headers = isRecord(value.headers)
    ? Object.fromEntries(
        Object.entries(value.headers).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;
  const path = typeof value.path === "string" ? value.path : undefined;
  return path === undefined && headers === undefined
    ? {}
    : {
        "ws-opts": {
          ...(path === undefined ? {} : { path }),
          ...(headers === undefined ? {} : { headers }),
        },
      };
}

function optionalGrpcOptions(value: unknown): Pick<NormalizedVlessNode, "grpc-opts"> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("VLESS grpc-opts must be an object");
  }
  if (value["grpc-service-name"] === undefined) {
    return {};
  }
  if (typeof value["grpc-service-name"] !== "string") {
    throw new Error("VLESS grpc-service-name must be a string");
  }
  return { "grpc-opts": { "grpc-service-name": value["grpc-service-name"] } };
}

function optionalRealityOptions(value: unknown): Pick<NormalizedVlessNode, "reality-opts"> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("VLESS reality-opts must be an object");
  }
  const publicKey = value["public-key"];
  if (typeof publicKey !== "string") {
    throw new Error("VLESS reality-opts requires public-key");
  }
  const shortId = value["short-id"];
  return {
    "reality-opts": {
      "public-key": publicKey,
      ...(typeof shortId === "string" ? { "short-id": shortId } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
