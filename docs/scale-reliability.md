# Scale, latency, and reliability benchmark

## Fixed environment

- Date: 2026-09-08
- Hardware: Apple M3 Pro, 12 logical CPUs, 36 GiB RAM
- Platform: macOS 26.6.2 (Darwin 25.6.0), arm64
- Runtime: Node.js v26.8.1, pnpm 10.24.0
- EgressKit baseline: `9b05c4d`
- Configuration: loopback-only EgressKit endpoint; one 500-node persisted revision backed by 500
  simulated listener servers; a separate soak daemon with 100 schedulable listeners and four
  pre-created 100-listener generation banks; 1,000 simultaneous CONNECT clients; the default
  10,000-session limit; EgressKit's own SQLite WAL state; and a 60-second combined soak

Reproduce from a clean checkout on equivalent hardware:

```sh
pnpm install --frozen-lockfile
pnpm test:scale 60 > docs/benchmarks/2026-09-08-m3-pro-darwin-arm64.json
```

The committed raw result is
[`benchmarks/2026-09-08-m3-pro-darwin-arm64.json`](benchmarks/2026-09-08-m3-pro-darwin-arm64.json).

## Method and results

The capacity run parsed and persisted a 500-node VLESS revision through the production daemon and
control-state database. A separate 100-node revision activated exactly 100 unique, schedulable
loopback listener generations observed from the runtime apply result. It then retained 1,000
CONNECT tunnels at the same time and retained 10,000 soft-sticky sessions. All four capacity
observations reached their design targets on this host. The CONNECT barrier counts only sockets that
remain readable and writable on the client and are simultaneously present on the simulated-listener
side; a tunnel closed before the barrier is excluded.

Gateway-added latency uses 200 paired observations against an in-process listener that acknowledges
CONNECT without contacting an upstream proxy or target. Both sides execute the identical CONNECT
request and wait for its 200 response; the direct listener result is subtracted from the full
EgressKit result for each pair. The reported value is the P95 of those per-pair non-negative
differences. This excludes public network, upstream CONNECT processing, VLESS, and target latency.
The measured added P95 was 0.308 ms against the design target of less than 20 ms.

The measured 60.069-second soak ran continuous CONNECT traffic concurrently with three full
subscription generation changes. Each change held an old-generation CONNECT open, observed a real
`draining` lease in the control database, then released it. A concurrent management connection made
283 reads against the daemon's own WAL-mode SQLite database while imports wrote revisions. Three
daemon crash-recovery callbacks exercised the Mihomo restart boundary. It attempted 9,056 CONNECTs;
448 returned HTTP 502, for a measured success rate of 95.0530%.

The soak can pass only when traffic runs for the requested duration with zero failures and all
required coverage is observed: at least three subscription updates, draining cycles, and Mihomo
restarts, at least one concurrent state read, and WAL journal mode.

Therefore long-duration concurrent reliability is **not verified** by this run. The dominant failure
is the restart/update window's HTTP 502 result, and none are waived. The runner rate is deliberately
bounded to avoid confusing single-host ephemeral-port exhaustion with a gateway failure. Further
recovery work and a longer multi-host soak are required before claiming the reliability target. The
capacity and latency observations above are bounded measurements on this fixed environment, not
universal supported limits.
