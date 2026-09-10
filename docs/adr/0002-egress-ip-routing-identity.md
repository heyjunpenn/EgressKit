# ADR 0002: Egress IP routing identity

## Status

Accepted on 2026-09-09.

## Decision

EgressKit distinguishes a transport node from an egress identity. A transport node is one logical
Clash/VLESS node generation behind a dedicated Mihomo listener. An egress identity is its verified
public IP address. Only a transport node with a verified egress IP may accept proxy traffic.

Discovery queues every unverified node without a total-size limit and uses five concurrent probes.
It falls back across multiple HTTPS identity providers. Successful identity records are stored in
SQLite by logical node ID and configuration generation and restored on daemon startup.

All routing policies use the egress IP as their stable identity. Rotate selects the egress IP that
has been unused for the longest, then a healthy transport node in that IP group. Sticky and strict
sessions bind to an egress IP rather than a logical node. A specified node ID or alias resolves to
an egress IP group; pre-connect fallback may use another healthy transport node in the same group,
but must never change to a different IP.

## Consequences

Different subscription nodes that share one public IP no longer consume multiple rotation slots.
Transport failover within the same IP preserves caller-visible identity. Fresh or changed node
generations remain warming and unavailable until discovery succeeds, so readiness can take longer
after importing a subscription. Explicit node selection now means "the exit represented by this
node" rather than an immutable internal listener.
