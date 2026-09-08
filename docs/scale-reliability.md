# Scale, latency, and reliability benchmark

## Fixed environment

- Date: 2026-09-08
- Hardware: Apple M3 Pro, 12 logical CPUs, 36 GiB RAM
- Platform: macOS 26.6.2 (Darwin 25.6.0), arm64
- Runtime: Node.js v26.8.1, pnpm 10.24.0
- EgressKit baseline: `9b05c4d`
- Configuration: loopback-only EgressKit endpoint, 500 generated VLESS subscription entries,
  100 active simulated Mihomo HTTP listeners, 1,000 simultaneous CONNECT clients, default 10,000
  session limit, SQLite WAL, and a 60-second combined soak

Reproduce from a clean checkout on equivalent hardware:

```sh
pnpm install --frozen-lockfile
pnpm test:scale 60 > docs/benchmarks/2026-09-08-m3-pro-darwin-arm64.json
```

The committed raw result is
[`benchmarks/2026-09-08-m3-pro-darwin-arm64.json`](benchmarks/2026-09-08-m3-pro-darwin-arm64.json).

## Method and results

The capacity run parsed 500 VLESS nodes, activated exactly 100 distinct loopback listener
generations through the production daemon/runtime boundary, retained 1,000 CONNECT tunnels at the
same time, and retained 10,000 soft-sticky sessions. All four capacity observations reached their
design targets on this host.

Gateway-added latency uses 200 paired observations against an in-process listener that acknowledges
CONNECT without contacting an upstream proxy or target. For every pair, the direct loopback TCP
connection time is subtracted from the full EgressKit CONNECT time; the reported value is the P95
of those per-pair non-negative differences. This explicitly excludes public network, upstream proxy,
VLESS, and target latency. The measured added P95 was 0.695 ms against the design target of less
than 20 ms.

The 60-second soak ran continuous batches of CONNECT traffic concurrently with three full
subscription generation changes and draining cycles, 2,949 SQLite WAL write/read cycles, and three
daemon crash-recovery callbacks that exercised the Mihomo restart boundary. It attempted 94,368
CONNECTs, of which 79,817 failed: 78,372 reported local `EADDRNOTAVAIL` and 1,445 returned HTTP 502.
The measured success rate was 15.4194%.

Therefore long-duration concurrent reliability is **not verified** by this run. The dominant failure
is exhaustion of the single-host load generator's ephemeral source ports; the remaining HTTP 502
results are retained separately and are not waived. A multi-host or connection-reusing load
generator is required before claiming the reliability target. The capacity and latency observations
above are bounded measurements on this fixed environment, not universal supported limits.
