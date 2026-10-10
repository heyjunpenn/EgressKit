# Single Mihomo runtime and ordinary HTTP relay

Accepted on 2026-10-09, following the requested Resin-inspired access model. EgressKit uses one
long-running official Mihomo process with a fixed loopback HTTP listener per transport generation.
Configuration updates go through the private Unix-socket controller; immutable internal names keyed
by listener port allow old and new generations to coexist while connections drain. Apply, retirement,
recovery and shutdown are serialized. Static `mihomo -t` checks remain short-lived subprocesses.
This avoids the per-node process overhead without introducing a shared mutable select group. A core
crash now affects every listener, and recovery restores the entire last applied configuration.

Add ordinary HTTP access at `/relay/<route>/<http|https>/<authority>/<path>?query`, inspired by
[Resin's reverse proxy mode](https://github.com/Resinat/Resin/blob/master/README.zh-CN.md).
`X-EgressKit-Token` carries the existing Proxy Token and the route uses the existing proxy username
syntax. Keep the target's `Authorization` header independent, strip gateway credentials and
hop-by-hop headers, rewrite redirects into relay URLs, and stream bodies without buffering or replay.
Each request establishes a target connection through its selected listener; HTTPS targets use verified
TLS. The gateway can read relay request/response content because it acts as the HTTP client. This
extends PRODUCT.md's prior forward-proxy-only scope; CONNECT remains an opaque TLS tunnel.

CDN and HTTP reverse proxy deployments may forward `/relay/` as ordinary HTTP, with caching and
request replay disabled and streaming supported. Forward proxy access still requires direct support
for HTTP Proxy / CONNECT. This does not promise browser-wide proxying, WebSocket upgrade, custom
client TLS fingerprints, or support beyond a CDN's own body size and timeout limits. The existing
ADR-0001 configuration boundary and ADR-0002 egress identity/session rules remain in force.

Resin uses embedded sing-box; EgressKit retains its independent Mihomo runtime rather than copying
that implementation. The reload behavior is based on Mihomo v1.19.30's
[configuration API](https://github.com/MetaCubeX/mihomo/blob/v1.19.30/hub/route/configs.go) and
[listener update logic](https://github.com/MetaCubeX/mihomo/blob/v1.19.30/listener/listener.go).
