export interface EgressdConfig {
  host: string;
  port: number;
  mihomoListener?: URL;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return 8787;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("EGRESSKIT_PORT must be an integer between 0 and 65535");
  }
  return port;
}

export function loadConfig(environment: NodeJS.ProcessEnv): EgressdConfig {
  const listener = environment.EGRESSKIT_MIHOMO_HTTP_LISTENER;
  const mihomoListener = listener === undefined ? undefined : new URL(listener);
  if (
    mihomoListener &&
    (mihomoListener.protocol !== "http:" || !isLoopback(mihomoListener.hostname))
  ) {
    throw new Error("EGRESSKIT_MIHOMO_HTTP_LISTENER must be an HTTP URL using a loopback host");
  }

  return {
    host: environment.EGRESSKIT_HOST ?? "127.0.0.1",
    port: parsePort(environment.EGRESSKIT_PORT),
    ...(mihomoListener === undefined ? {} : { mihomoListener }),
  };
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
