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

  return {
    host: environment.EGRESSKIT_HOST ?? "127.0.0.1",
    port: parsePort(environment.EGRESSKIT_PORT),
    ...(listener === undefined ? {} : { mihomoListener: new URL(listener) }),
  };
}
