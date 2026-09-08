import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
} from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

import { type ImportedVlessRevision, importLocalVlessYaml } from "./subscription.js";

export interface MihomoRuntime {
  apply(config: ImportedVlessRevision["mihomoConfig"]): Promise<ReadonlyMap<string, URL>>;
}

export interface EgressdOptions {
  adminToken?: string;
  allowUnsafeUnauthenticatedProxy?: boolean;
  host: string;
  log?: (event: EgressdLogEvent) => void;
  mihomoListener?: URL;
  mihomoRuntime?: MihomoRuntime;
  port: number;
  proxyAuthentication?: false | { tokens: readonly string[] };
}

export interface EgressdLogEvent {
  event: "egressd.proxy_auth.disabled";
  exposure: "non-loopback";
  host: string;
  level: "warn";
}

export interface RunningEgressd {
  address: {
    host: string;
    port: number;
  };
  close(): Promise<void>;
  importLocalSubscription(source: string): Promise<ImportedVlessRevision>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startEgressd(options: EgressdOptions): Promise<RunningEgressd> {
  if (options.proxyAuthentication === false && !isLoopbackBindHost(options.host)) {
    if (!options.allowUnsafeUnauthenticatedProxy) {
      throw new Error("refusing to disable proxy authentication on a non-loopback host");
    }
    const event: EgressdLogEvent = {
      event: "egressd.proxy_auth.disabled",
      exposure: "non-loopback",
      host: options.host,
      level: "warn",
    };
    (options.log ?? ((entry) => process.stderr.write(`${JSON.stringify(entry)}\n`)))(event);
  }
  let activeMihomoListener = options.mihomoListener;
  const importLocalSubscription = async (source: string): Promise<ImportedVlessRevision> => {
    if (!options.mihomoRuntime) {
      throw new Error("Mihomo runtime is not configured");
    }
    const revision = importLocalVlessYaml(source, { firstListenerPort: 20_000 });
    if (revision.nodes.length === 0) {
      throw new Error("subscription contains no VLESS nodes");
    }
    const listeners = await options.mihomoRuntime.apply(revision.mihomoConfig);
    for (const node of revision.nodes) {
      const listener = listeners.get(node.name);
      if (!listener || !isLoopbackHttpListener(listener)) {
        throw new Error(`Mihomo runtime did not start a loopback listener for ${node.name}`);
      }
    }
    const selected = listeners.get(revision.nodes[0]?.name ?? "");
    if (!selected) {
      throw new Error("Mihomo runtime did not start the imported listener");
    }
    activeMihomoListener = selected;
    return revision;
  };

  const server = createServer((incoming, response) => {
    if (incoming.method === "GET" && incoming.url === "/live") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "live" }));
      return;
    }

    if (incoming.method === "POST" && incoming.url === "/subscriptions/local") {
      if (
        !options.adminToken ||
        incoming.headers.authorization !== `Bearer ${options.adminToken}`
      ) {
        response.writeHead(401, { "www-authenticate": "Bearer" });
        response.end();
        return;
      }
      readBody(incoming)
        .then(importLocalSubscription)
        .then((revision) => {
          response.writeHead(201, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              nodes: revision.mihomoConfig.listeners.map((listener) => ({
                name: listener.proxy,
                listener: { host: listener.listen, port: listener.port },
              })),
            }),
          );
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          const status = message.includes("runtime") || message.includes("listener") ? 503 : 422;
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: message }));
        });
      return;
    }

    if (!authenticateProxyRequest(incoming, options.proxyAuthentication)) {
      writeProxyAuthenticationRequired(response);
      return;
    }

    if (!activeMihomoListener || !isAbsoluteHttpUrl(incoming.url)) {
      response.writeHead(activeMihomoListener ? 400 : 502);
      response.end();
      return;
    }

    const { "proxy-authorization": _proxyAuthorization, ...forwardedHeaders } = incoming.headers;
    const upstream = request(
      activeMihomoListener,
      {
        headers: {
          ...forwardedHeaders,
          via: appendVia(incoming.headers.via, "1.1 egresskit"),
        },
        method: incoming.method,
        path: incoming.url,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) {
        response.writeHead(502);
      }
      response.end();
    });
    incoming.pipe(upstream);
  });
  server.on("connect", (incoming, clientSocket, head) => {
    if (!authenticateProxyRequest(incoming, options.proxyAuthentication)) {
      clientSocket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="EgressKit"\r\n\r\n',
      );
      return;
    }
    handleConnect(incoming, clientSocket, head, activeMihomoListener);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("egressd did not bind a TCP address");
  }

  return {
    address: { host: options.host, port: address.port },
    close: () => closeServer(server),
    importLocalSubscription,
  };
}

function isLoopbackBindHost(host: string): boolean {
  return (
    host === "localhost" || host === "::1" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function authenticateProxyRequest(
  incoming: IncomingMessage,
  authentication: EgressdOptions["proxyAuthentication"],
): boolean {
  if (authentication === false) {
    return true;
  }
  const credentials = parseBasicProxyCredentials(incoming.headers["proxy-authorization"]);
  if (!credentials || !parseProxyUsername(credentials.username)) {
    return false;
  }
  const passwordHash = createHash("sha256").update(credentials.password).digest();
  return (authentication?.tokens ?? []).some((token) =>
    timingSafeEqual(passwordHash, createHash("sha256").update(token).digest()),
  );
}

function parseBasicProxyCredentials(
  authorization: string | undefined,
): { password: string; username: string } | undefined {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization ?? "");
  const encoded = match?.[1];
  if (!encoded || encoded.length % 4 !== 0) {
    return undefined;
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    return undefined;
  }
  const separator = decoded.indexOf(":");
  if (separator < 1) {
    return undefined;
  }
  return {
    username: decoded.subarray(0, separator).toString("utf8"),
    password: decoded.subarray(separator + 1).toString("utf8"),
  };
}

function parseProxyUsername(username: string): boolean {
  if (username === "rotate") {
    return true;
  }
  const match = /^(sticky|strict|node)\.(.+)$/.exec(username);
  const value = match?.[2];
  return Boolean(
    value &&
      !value.includes(":") &&
      [...value].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 31 && codePoint !== 127;
      }),
  );
}

function writeProxyAuthenticationRequired(response: import("node:http").ServerResponse): void {
  response.writeHead(407, { "proxy-authenticate": 'Basic realm="EgressKit"' });
  response.end();
}

function readBody(incoming: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("local subscription exceeds 1 MiB"));
        incoming.destroy();
        return;
      }
      chunks.push(chunk);
    });
    incoming.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    incoming.on("error", reject);
  });
}

function isLoopbackHttpListener(listener: URL): boolean {
  return (
    listener.protocol === "http:" &&
    (listener.hostname === "localhost" ||
      listener.hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(listener.hostname))
  );
}

function handleConnect(
  incoming: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  mihomoListener: URL | undefined,
): void {
  if (!mihomoListener || !incoming.url) {
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    return;
  }

  const listenerPort = Number(mihomoListener.port || 80);
  const listenerSocket = connect(listenerPort, mihomoListener.hostname);
  let tunnelEstablished = false;
  listenerSocket.on("connect", () => {
    listenerSocket.write(
      `CONNECT ${incoming.url} HTTP/1.1\r\nHost: ${incoming.url}\r\nVia: 1.1 egresskit\r\n\r\n`,
    );
  });

  let responseHead = Buffer.alloc(0);
  const receiveResponseHead = (chunk: Buffer): void => {
    responseHead = Buffer.concat([responseHead, chunk]);
    const end = responseHead.indexOf("\r\n\r\n");
    if (end === -1) {
      if (responseHead.length > 64 * 1024) {
        listenerSocket.destroy(new Error("Mihomo CONNECT response headers are too large"));
      }
      return;
    }

    listenerSocket.off("data", receiveResponseHead);
    const header = responseHead.subarray(0, end + 4);
    const remaining = responseHead.subarray(end + 4);
    clientSocket.write(header);
    if (!header.toString("latin1").startsWith("HTTP/1.1 200")) {
      clientSocket.end(remaining);
      listenerSocket.end();
      return;
    }

    tunnelEstablished = true;
    if (head.length > 0) {
      listenerSocket.write(head);
    }
    if (remaining.length > 0) {
      clientSocket.write(remaining);
    }
    clientSocket.pipe(listenerSocket);
    listenerSocket.pipe(clientSocket);
  };
  listenerSocket.on("data", receiveResponseHead);
  listenerSocket.on("error", () => {
    if (!clientSocket.destroyed) {
      if (tunnelEstablished) {
        clientSocket.destroy();
      } else {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
    }
  });
  clientSocket.on("error", () => listenerSocket.destroy());
  clientSocket.once("close", () => listenerSocket.destroy());
  listenerSocket.once("close", () => clientSocket.destroy());
}

function isAbsoluteHttpUrl(value: string | undefined): value is string {
  if (value === undefined) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function appendVia(current: IncomingHttpHeaders["via"], value: string): string {
  if (current === undefined) {
    return value;
  }
  return `${Array.isArray(current) ? current.join(", ") : current}, ${value}`;
}
