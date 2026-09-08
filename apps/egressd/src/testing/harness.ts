import { createServer, type IncomingHttpHeaders, request, type Server } from "node:http";
import { connect, type Server as TcpServer, type Socket as TcpSocket } from "node:net";
import { connect as connectTls, createServer as createTlsServer, type TLSSocket } from "node:tls";

const TEST_PSK = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
const TEST_PSK_CIPHER = "PSK-AES128-CBC-SHA256";

export type ConnectionPhase =
  | "before-target-connect"
  | "after-target-connect"
  | "after-tunnel-established";

export interface ObservedRequest {
  headers: IncomingHttpHeaders;
  body: string;
  method: string;
  url: string;
}

export interface RunningHttpFixture {
  host: string;
  port: number;
  close(): Promise<void>;
}

export class ManualClock {
  #now: number;

  constructor(initialTime = 0) {
    this.#now = initialTime;
  }

  now(): number {
    return this.#now;
  }

  advanceBy(milliseconds: number): void {
    if (milliseconds < 0) {
      throw new Error("ManualClock cannot move backwards");
    }
    this.#now += milliseconds;
  }
}

export class ConnectionFaultPlan {
  #failures = new Map<ConnectionPhase, Error[]>();

  failNext(phase: ConnectionPhase, error = new Error(`injected ${phase} failure`)): void {
    const failures = this.#failures.get(phase) ?? [];
    failures.push(error);
    this.#failures.set(phase, failures);
  }

  trigger(phase: ConnectionPhase): void {
    const failures = this.#failures.get(phase);
    const failure = failures?.shift();
    if (failure) {
      throw failure;
    }
  }
}

function listen(server: Server | TcpServer): Promise<RunningHttpFixture> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("fixture did not bind a TCP address"));
        return;
      }
      resolve({
        host: "127.0.0.1",
        port: address.port,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    });
  });
}

export async function startTargetServer(
  observedRequests: ObservedRequest[],
  options: { closeWithoutResponse?: boolean } = {},
): Promise<RunningHttpFixture> {
  return listen(
    createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const observed = {
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString(),
          method: incoming.method ?? "GET",
          url: incoming.url ?? "",
        };
        observedRequests.push(observed);
        if (options.closeWithoutResponse) {
          incoming.socket.destroy();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(observed));
      });
    }),
  );
}

export async function startSimulatedMihomoListener(
  faults = new ConnectionFaultPlan(),
  observedConnectTargets: string[] = [],
  observedHttpRequests: string[] = [],
): Promise<RunningHttpFixture> {
  const server = createServer((incoming, response) => {
    try {
      faults.trigger("before-target-connect");
      observedHttpRequests.push(`${incoming.method} ${incoming.url}`);
      const target = new URL(incoming.url ?? "");
      const upstream = request(
        target,
        {
          headers: {
            ...incoming.headers,
            host: target.host,
            via: appendVia(incoming.headers.via, "1.1 simulated-mihomo"),
          },
          method: incoming.method,
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
      upstream.on("socket", (socket) => {
        socket.prependOnceListener("connect", () => {
          try {
            faults.trigger("after-target-connect");
          } catch (error) {
            socket.destroy(error as Error);
          }
        });
      });
      incoming.pipe(upstream);
    } catch {
      response.writeHead(502);
      response.end();
    }
  });
  server.on("connect", (incoming, clientSocket, head) => {
    try {
      faults.trigger("before-target-connect");
      const [host, portText] = (incoming.url ?? "").split(":");
      const port = Number(portText);
      if (!host || !Number.isInteger(port)) {
        clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      const targetSocket = connect(port, host);
      targetSocket.prependOnceListener("connect", () => {
        try {
          faults.trigger("after-target-connect");
          observedConnectTargets.push(`${host}:${port}`);
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          try {
            faults.trigger("after-tunnel-established");
          } catch {
            clientSocket.destroy();
            targetSocket.destroy();
            return;
          }
          if (head.length > 0) {
            targetSocket.write(head);
          }
          clientSocket.pipe(targetSocket);
          targetSocket.pipe(clientSocket);
        } catch (error) {
          targetSocket.destroy(error as Error);
        }
      });
      targetSocket.on("error", () => clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    } catch {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    }
  });
  return listen(server);
}

export async function startHttpsTarget(
  receivedRequests: string[],
  connectionEvents: string[] = [],
): Promise<RunningHttpFixture> {
  const server = createTlsServer(
    {
      ciphers: TEST_PSK_CIPHER,
      maxVersion: "TLSv1.2",
      pskCallback: () => TEST_PSK,
    },
    (socket) => {
      socket.on("data", (payload) => {
        receivedRequests.push(payload.toString());
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nobserved");
      });
    },
  );
  server.on("connection", (socket) => {
    connectionEvents.push("opened");
    socket.once("close", () => connectionEvents.push("closed"));
  });
  return listen(server);
}

export function connectTestTls(socket: TcpSocket): TLSSocket {
  return connectTls({
    socket,
    ciphers: TEST_PSK_CIPHER,
    maxVersion: "TLSv1.2",
    pskCallback: () => ({ identity: "egresskit-test", psk: TEST_PSK }),
    rejectUnauthorized: false,
  });
}

function appendVia(current: string | string[] | undefined, value: string): string {
  if (current === undefined) {
    return value;
  }
  return `${Array.isArray(current) ? current.join(", ") : current}, ${value}`;
}
