import { createHash, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export type ProxyAuthentication = false | { tokens: readonly string[] };

export type ProxyRoute =
  | { mode: "rotate" }
  | { mode: "sticky" | "strict"; sessionKey: string }
  | { mode: "node"; selector: string };

const PROXY_AUTHENTICATE = 'Basic realm="EgressKit"';

export function authorizeProxyRequest(
  authorization: string | undefined,
  authentication: ProxyAuthentication | undefined,
): ProxyRoute | undefined {
  if (authentication === false) {
    return { mode: "rotate" };
  }
  const credentials = parseBasicProxyCredentials(authorization);
  const route = credentials ? parseProxyUsername(credentials.username) : undefined;
  if (!credentials || !route || !matchesToken(credentials.password, authentication?.tokens ?? [])) {
    return undefined;
  }
  return route;
}

export function rejectHttpProxyAuthentication(response: ServerResponse): void {
  response.writeHead(407, { "proxy-authenticate": PROXY_AUTHENTICATE });
  response.end();
}

export function rejectConnectProxyAuthentication(socket: Duplex): void {
  socket.end(
    `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${PROXY_AUTHENTICATE}\r\n\r\n`,
  );
}

function matchesToken(password: string, tokens: readonly string[]): boolean {
  const passwordHash = createHash("sha256").update(password).digest();
  return tokens.some((token) =>
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

function parseProxyUsername(username: string): ProxyRoute | undefined {
  if (username === "rotate") {
    return { mode: "rotate" };
  }
  const match = /^(sticky|strict|node)\.(.+)$/.exec(username);
  const mode = match?.[1];
  const value = match?.[2];
  if (!mode || !value || !isValidUsernameValue(value)) {
    return undefined;
  }
  if (mode === "node") {
    try {
      const selector = decodeURIComponent(value);
      if (!selector || hasControlCharacter(selector)) {
        return undefined;
      }
      return { mode: "node", selector };
    } catch {
      return undefined;
    }
  }
  if (mode === "sticky" || mode === "strict") {
    return { mode, sessionKey: value };
  }
  return undefined;
}

function isValidUsernameValue(value: string): boolean {
  return !value.includes(":") && !hasControlCharacter(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}
