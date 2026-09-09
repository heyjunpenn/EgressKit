export function gatewayAddress(host: string, port: number): string {
  const displayHost = host === "0.0.0.0" || host === "::" ? window.location.hostname : host;
  const normalizedHost = displayHost.replace(/^\[(.*)]$/, "$1");
  const urlHost = normalizedHost.includes(":") ? `[${normalizedHost}]` : normalizedHost;
  return `${urlHost}:${port}`;
}
