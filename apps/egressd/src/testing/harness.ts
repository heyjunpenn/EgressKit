import { createServer, type IncomingHttpHeaders, request, type Server } from "node:http";

export type ConnectionPhase = "before-target-connect" | "after-target-connect";

export interface ObservedRequest {
  headers: IncomingHttpHeaders;
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

function listen(server: Server): Promise<RunningHttpFixture> {
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
): Promise<RunningHttpFixture> {
  return listen(
    createServer((incoming, response) => {
      const observed = {
        headers: incoming.headers,
        method: incoming.method ?? "GET",
        url: incoming.url ?? "",
      };
      observedRequests.push(observed);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(observed));
    }),
  );
}

export async function startSimulatedMihomoListener(
  faults = new ConnectionFaultPlan(),
): Promise<RunningHttpFixture> {
  return listen(
    createServer((incoming, response) => {
      try {
        faults.trigger("before-target-connect");
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
    }),
  );
}

function appendVia(current: string | string[] | undefined, value: string): string {
  if (current === undefined) {
    return value;
  }
  return `${Array.isArray(current) ? current.join(", ") : current}, ${value}`;
}
