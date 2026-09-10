# ADR 0002: Egress IP routing identity

## Status

Accepted on 2026-09-09.

## Decision

EgressKit distinguishes a transport node from an egress identity. A transport node is one logical
Clash/VLESS node generation behind a dedicated Mihomo listener. An egress identity is its verified
public IP address. Only a transport node with a verified egress IP may accept proxy traffic.

Scheduled discovery checks nodes in stable order, ten per round by default, with at most five
concurrent probes. Manual discovery can check one node or the full set. It falls back across
multiple HTTPS identity providers. Successful identity records are stored in SQLite by logical
node ID and configuration generation and restored on daemon startup.

The externally visible node state is binary: available when a verified exit IP exists, otherwise
unavailable. Ten consecutive identity-check or proxy-connection failures revoke the stored exit
identity. An unavailable node returns to available only when a scheduled or manual identity check
obtains an exit IP.

All routing policies use the egress IP as their stable identity. Rotate selects the egress IP that
has been unused for the longest, then an available transport node in that IP group. Sticky and strict
sessions bind to an egress IP rather than a logical node. A specified node ID or alias resolves to
an egress IP group; pre-connect fallback may use another available transport node in the same group,
but must never change to a different IP.

## Consequences

Different subscription nodes that share one public IP no longer consume multiple rotation slots.
Transport failover within the same IP preserves caller-visible identity. Fresh or changed node
generations remain unavailable until discovery succeeds, so readiness can take longer after
importing a subscription. Explicit node selection now means "the exit represented by this node"
rather than an immutable internal listener.
