# Authorized live VLESS verification

This test is deliberately separate from secretless PR CI. `pnpm verify` never invokes it, and the
release workflow never receives its credentials. Never print or record the subscription URL, node
address, UUID, authentication material, or observed IP address.

## Reproduce

Install the repository-pinned official Mihomo asset with `egresskit runtime install`, then provide
the resulting executable path, an authorized HTTPS subscription, and an HTTPS JSON target whose
response has an `ip` field:

```sh
export EGRESSKIT_MIHOMO_BINARY=/private/path/to/mihomo
export EGRESSKIT_LIVE_SUBSCRIPTION_URL='set-in-your-secret-store'
export EGRESSKIT_LIVE_TARGET_URL='https://your-authorized-ip-echo.example/json'
pnpm test:live:vless
```

The runner uses an isolated temporary state directory, generated one-run admin and proxy tokens,
the real `egressd` and `egresskit` entry points, and the EgressKit proxy as the single egress
endpoint. It imports the remote subscription, lets official Mihomo check and apply it, makes a
direct target request, then makes the same request through an authenticated CONNECT tunnel. It
reports only four independent outcomes: local implementation, Mihomo acceptance, target
reachability, and real exit verification. Real exit verification passes only when the target
returns a valid proxy-observed IP distinct from the direct IP. Temporary state is removed.

## Evidence: 2026-09-08

- EgressKit commit under test: `4e97483` (the merged Issue #22 baseline).
- Platform: Darwin 25.6.0 arm64; Node.js v26.8.1.
- Official runtime: Mihomo Meta v1.19.30, Darwin arm64; repository-pinned SHA-256 verified.
- Configuration category: remote Mihomo YAML containing 170 VLESS nodes using TCP transport.
- Local implementation: passed; daemon started and the subscription operation completed.
- Mihomo acceptance: passed; the official runtime checked and applied the generated configuration.
- Target reachability: passed through the authenticated EgressKit CONNECT endpoint.
- Real exit verification: passed; the target observed a valid IP distinct from the direct exit.

No subscription URL, node secret, node endpoint, UUID, token, direct IP, or observed exit IP is
stored in this evidence.
