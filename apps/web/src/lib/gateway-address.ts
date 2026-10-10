export function gatewayAddress(host: string, port: number): string {
  const displayHost = host === "0.0.0.0" || host === "::" ? window.location.hostname : host;
  const normalizedHost = displayHost.replace(/^\[(.*)]$/, "$1");
  const urlHost = normalizedHost.includes(":") ? `[${normalizedHost}]` : normalizedHost;
  return `${urlHost}:${port}`;
}

export function gatewayUrl(
  host: string,
  port: number,
  browserOrigin = window.location.origin,
  publicProxyUrl = "",
): string {
  if (publicProxyUrl) return publicProxyUrl;
  const displayHost = host === "0.0.0.0" || host === "::" ? new URL(browserOrigin).hostname : host;
  return `http://${gatewayAddress(displayHost, port)}`;
}

export function relayUrl(publicRelayUrl = "", browserOrigin = window.location.origin): string {
  return (publicRelayUrl || browserOrigin).replace(/\/$/, "");
}
