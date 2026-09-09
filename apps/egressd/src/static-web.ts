import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export async function serveStaticWeb(
  request: IncomingMessage,
  response: ServerResponse,
  directory: string,
): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }
  const pathname = new URL(request.url ?? "/", "http://egresskit.local").pathname;
  if (pathname.startsWith("/assets/")) {
    return sendFile(response, directory, pathname.slice(1), request.method === "HEAD", false);
  }
  if (extname(pathname) !== "") {
    return sendFile(response, directory, pathname.slice(1), request.method === "HEAD", false);
  }
  return sendFile(response, directory, "index.html", request.method === "HEAD", true);
}

async function sendFile(
  response: ServerResponse,
  directory: string,
  relativePath: string,
  headOnly: boolean,
  shellFallback: boolean,
): Promise<boolean> {
  const root = resolve(directory);
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    writeNotFound(response);
    return true;
  }
  try {
    if (!(await stat(path)).isFile()) {
      writeNotFound(response);
      return true;
    }
    const body = await readFile(path);
    response.writeHead(200, {
      "cache-control": shellFallback ? "no-cache" : "public, max-age=31536000, immutable",
      "content-length": body.byteLength,
      "content-type": contentTypes[extname(path)] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
    });
    response.end(headOnly ? undefined : body);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      writeNotFound(response);
      return true;
    }
    response.writeHead(500);
    response.end();
  }
  return true;
}

function writeNotFound(response: ServerResponse): void {
  response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "web asset not found" }));
}
