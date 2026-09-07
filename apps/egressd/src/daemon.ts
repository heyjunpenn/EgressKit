import { createServer, type IncomingHttpHeaders, request, type Server } from "node:http";

export interface EgressdOptions {
  host: string;
  mihomoListener?: URL;
  port: number;
}

export interface RunningEgressd {
  address: {
    host: string;
    port: number;
  };
  close(): Promise<void>;
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
  const server = createServer((incoming, response) => {
    if (incoming.method === "GET" && incoming.url === "/live") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "live" }));
      return;
    }

    if (!options.mihomoListener || !isAbsoluteHttpUrl(incoming.url)) {
      response.writeHead(options.mihomoListener ? 400 : 502);
      response.end();
      return;
    }

    const upstream = request(
      options.mihomoListener,
      {
        headers: {
          ...incoming.headers,
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
  };
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
