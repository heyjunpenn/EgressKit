import type { IncomingHttpHeaders } from "node:http";

/** Origin-form HTTP access, suitable for ordinary reverse proxies and CDNs. */
export function parseRelayTarget(path: string): { target: URL; username: string } {
  const match = /^\/relay\/([^/?]+)\/(https?)\/([^/?]+)((?:\/|\?)[^#]*)?$/.exec(path);
  if (!match) throw new Error("invalid relay URL");
  const username = decodeURIComponent(match[1] as string);
  const authority = match[3] as string;
  if (/[\\@#\s%]/.test(authority)) throw new Error("invalid relay authority");
  const target = new URL(`${match[2]}://${authority}${match[4] ?? "/"}`);
  if (!target.hostname || target.username || target.password)
    throw new Error("invalid relay target");
  return { target, username };
}

export function relayLocation(location: string, target: URL, username: string): string | undefined {
  try {
    const redirect = new URL(location, target);
    if (!["http:", "https:"].includes(redirect.protocol) || redirect.username || redirect.password)
      return undefined;
    return `/relay/${encodeURIComponent(username)}/${redirect.protocol.slice(0, -1)}/${redirect.host}${redirect.pathname}${redirect.search}${redirect.hash}`;
  } catch {
    return undefined;
  }
}

export function relayHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const removed = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    ...String(headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((name) => name.trim()),
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !removed.has(name.toLowerCase()) && !name.toLowerCase().startsWith("x-egresskit-"),
    ),
  );
}
