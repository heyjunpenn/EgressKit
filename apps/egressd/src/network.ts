import { isIP } from "node:net";

export function isLoopbackHost(hostname: string): boolean {
  const host =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (host === "localhost") {
    return true;
  }
  if (isIP(host) === 4) {
    return host.split(".")[0] === "127";
  }
  return isIP(host) === 6 && new URL(`http://[${host}]`).hostname === "[::1]";
}

export function isLoopbackHttpUrl(listener: URL): boolean {
  return listener.protocol === "http:" && isLoopbackHost(listener.hostname);
}
