# ADR 0001: Database-backed runtime settings

## Status

Accepted on 2026-09-09.

## Decision

`EGRESSKIT_ADMIN_TOKEN` is the only EgressKit environment variable. All remaining runtime
configuration is initialized with defaults in the control SQLite database and managed through the
authenticated Settings API and console page. The Proxy Token defaults to the Admin Token on first
start and may be changed independently afterwards.

Proxy Token is stored as recoverable plaintext in the settings record so the authenticated console
can edit it and generate executable examples. The existing hashed multi-token registry remains the
data-plane verifier. Access to the state directory is therefore part of the credential boundary.

Network listener, Mihomo, health-check, subscription-refresh, reputation, and session changes are
persisted immediately but require a daemon restart. A changed Proxy Token is also applied to the
running token registry immediately.

## Consequences

This explicit product decision supersedes earlier product text requiring Admin Token and Proxy Token
to be different. Sharing the first-start default reduces setup friction but increases the impact of a
credential leak, so operators should set a separate Proxy Token in Settings for exposed deployments.
