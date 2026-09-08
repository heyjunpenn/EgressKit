import { request } from "node:http";

import type { ControlCliClient } from "./control-cli.js";

export class UnixControlClient implements ControlCliClient {
  readonly #adminToken: string;
  readonly #socketPath: string;

  constructor(options: { adminToken: string; socketPath: string }) {
    this.#adminToken = options.adminToken;
    this.#socketPath = options.socketPath;
  }

  request(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const outgoing = request(
        {
          headers: {
            authorization: `Bearer ${this.#adminToken}`,
            ...(payload === undefined
              ? {}
              : {
                  "content-length": Buffer.byteLength(payload),
                  "content-type": "application/json",
                }),
          },
          method,
          path,
          socketPath: this.#socketPath,
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let interrupted = false;
          const rejectInterrupted = (cause?: Error) => {
            if (interrupted) {
              return;
            }
            interrupted = true;
            reject(new Error("daemon response was interrupted", { cause }));
          };
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("aborted", () => rejectInterrupted());
          incoming.on("error", rejectInterrupted);
          incoming.on("end", () => {
            if (interrupted) {
              return;
            }
            const text = Buffer.concat(chunks).toString();
            let result: Record<string, unknown>;
            try {
              const parsed: unknown = text ? JSON.parse(text) : {};
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("response is not a JSON object");
              }
              result = parsed as Record<string, unknown>;
            } catch (error) {
              reject(new Error("daemon returned invalid JSON", { cause: error }));
              return;
            }
            if ((incoming.statusCode ?? 500) >= 400) {
              reject(new Error(String(result.error ?? `daemon returned ${incoming.statusCode}`)));
              return;
            }
            resolve(result);
          });
        },
      );
      outgoing.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
          reject(new Error(`egressd is not running at ${this.#socketPath}`, { cause: error }));
          return;
        }
        reject(error);
      });
      outgoing.end(payload);
    });
  }
}
