# ADR 0001: Database-backed runtime settings

## Status

Accepted on 2026-09-09.

## Decision

`EGRESSKIT_ADMIN_TOKEN` and the optional public entry address variables described below are
bootstrap environment variables. All remaining runtime configuration is initialized with defaults in
the control SQLite database and managed through the authenticated Settings API and console page.
The Proxy Token defaults to the Admin Token on first start and may be changed independently afterwards.

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

## Public entry addresses

As of 2026-10-10, the user's deployment decision makes public entry addresses an exception to the
original Admin-Token-only environment policy. `EGRESSKIT_PUBLIC_PROXY_URL` and
`EGRESSKIT_PUBLIC_RELAY_URL` are read and validated at daemon startup. They are not persisted in
SQLite or editable through the console or Settings API. Changing them requires restarting the daemon
(or recreating the container with the new environment).

The configured addresses update console display, copy actions and client examples. Blank values select
automatic defaults: the actual HTTP listener host/port (using the console hostname for wildcard binds)
for forward proxy access, and the current console origin for relay access. These describe deployment
public endpoints; listener binding is still controlled by database-backed `host` and `port`.
