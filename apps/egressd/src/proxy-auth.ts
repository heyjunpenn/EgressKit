import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export type ProxyAuthentication =
  | false
  | { matches(token: string): boolean }
  | { tokens: readonly string[] };

interface StoredProxyToken {
  expiresAt?: number;
  hash: Buffer;
  id: string;
}

export interface PersistedProxyToken {
  expiresAt?: number;
  hash: string;
  id: string;
}

const MAX_PROXY_TOKEN_GRACE_MS = 30 * 24 * 60 * 60 * 1_000;

export class ProxyTokenRegistry {
  readonly #now: () => number;
  readonly #tokens = new Map<string, StoredProxyToken>();

  constructor(
    options: {
      initialTokens?: readonly string[];
      now?: () => number;
      persistedTokens?: readonly PersistedProxyToken[];
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    for (const token of options.persistedTokens ?? []) {
      const hash = Buffer.from(token.hash, "hex");
      if (hash.length !== 32) {
        throw new Error("persisted proxy token hash is invalid");
      }
      this.#tokens.set(token.id, {
        ...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }),
        hash,
        id: token.id,
      });
    }
    for (const token of options.initialTokens ?? []) {
      this.add(token);
    }
  }

  add(token: string): { id: string; status: "active" } {
    const hash = tokenHash(token);
    for (const stored of this.#tokens.values()) {
      if (timingSafeEqual(stored.hash, hash)) {
        delete stored.expiresAt;
        return { id: stored.id, status: "active" };
      }
    }
    const stored: StoredProxyToken = { hash, id: randomUUID() };
    this.#tokens.set(stored.id, stored);
    return { id: stored.id, status: "active" };
  }

  revoke(
    id: string,
    graceMs: number,
  ): { expiresAt: number; status: "grace" } | { status: "revoked" } | undefined {
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > MAX_PROXY_TOKEN_GRACE_MS) {
      throw new Error("proxy token graceMs is outside the supported range");
    }
    const stored = this.#tokens.get(id);
    if (!stored) {
      return undefined;
    }
    if (graceMs === 0) {
      this.#tokens.delete(id);
      return { status: "revoked" };
    }
    stored.expiresAt = this.#now() + graceMs;
    return { expiresAt: stored.expiresAt, status: "grace" };
  }

  matches(token: string): boolean {
    this.#removeExpired();
    if (!token) {
      return false;
    }
    const hash = tokenHash(token);
    return [...this.#tokens.values()].some((stored) => timingSafeEqual(hash, stored.hash));
  }

  snapshot(): Array<{ expiresAt?: number; id: string; status: "active" | "grace" }> {
    this.#removeExpired();
    return [...this.#tokens.values()].map(({ expiresAt, id }) => ({
      ...(expiresAt === undefined ? {} : { expiresAt }),
      id,
      status: expiresAt === undefined ? "active" : "grace",
    }));
  }

  persistedSnapshot(): PersistedProxyToken[] {
    this.#removeExpired();
    return [...this.#tokens.values()].map(({ expiresAt, hash, id }) => ({
      ...(expiresAt === undefined ? {} : { expiresAt }),
      hash: hash.toString("hex"),
      id,
    }));
  }

  restore(tokens: readonly PersistedProxyToken[]): void {
    this.#tokens.clear();
    for (const token of tokens) {
      const hash = Buffer.from(token.hash, "hex");
      if (hash.length !== 32) {
        throw new Error("persisted proxy token hash is invalid");
      }
      this.#tokens.set(token.id, {
        ...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }),
        hash,
        id: token.id,
      });
    }
  }

  #removeExpired(): void {
    const now = this.#now();
    for (const [id, stored] of this.#tokens) {
      if (stored.expiresAt !== undefined && stored.expiresAt <= now) {
        this.#tokens.delete(id);
      }
    }
  }
}

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
  if (!credentials || !route || !matchesAuthentication(credentials.password, authentication)) {
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

function matchesAuthentication(
  password: string,
  authentication: Exclude<ProxyAuthentication, false> | undefined,
): boolean {
  if (!password) {
    return false;
  }
  if (authentication && "matches" in authentication) {
    return authentication.matches(password);
  }
  const passwordHash = tokenHash(password);
  return (authentication?.tokens ?? []).some((token) =>
    timingSafeEqual(passwordHash, tokenHash(token)),
  );
}

function tokenHash(token: string): Buffer {
  if (!token) {
    throw new Error("proxy token must not be empty");
  }
  return createHash("sha256").update(token).digest();
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
