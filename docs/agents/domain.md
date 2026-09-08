# Domain Docs

This repository uses a single-context domain documentation layout.

Engineering skills should follow these rules when exploring or modifying the
codebase.

## Before exploring, read these

- Read `CONTEXT.md` at the repository root when it exists.
- Read relevant ADRs under `docs/adr/`.
- Treat `PRODUCT.md` as the current confirmed product and technical baseline
  until a more specific domain document or accepted ADR narrows a decision.

If `CONTEXT.md` or `docs/adr/` does not exist, proceed silently. Do not flag the
absence or create placeholder domain documents. Domain-modeling workflows create
them lazily when terminology or architectural decisions are actually resolved.

## File structure

The intended single-context layout is:

```text
/
├── CONTEXT.md
├── PRODUCT.md
├── docs/
│   └── adr/
│       ├── 0001-example-decision.md
│       └── 0002-another-decision.md
├── apps/
└── packages/
```

`CONTEXT.md` contains the shared domain glossary, boundaries, invariants, and
important distinctions for EgressKit.

`docs/adr/` contains repository-wide architectural decisions.

## Use the glossary’s vocabulary

When output names a domain concept in an Issue title, implementation proposal,
test name, or documentation change, use the term defined in `CONTEXT.md`.

Do not silently drift to a synonym that the glossary explicitly avoids.

If a needed concept is missing, reconsider whether the new term is necessary.
If it represents a genuine domain gap, record it for the domain-modeling
workflow instead of inventing competing vocabulary ad hoc.

## Respect the product baseline

`PRODUCT.md` defines the accepted EgressKit v1 product scope and technical
baseline. Do not expand an implementation ticket beyond that scope without an
explicit product decision.

In particular, preserve the documented distinctions between:

- new proxy requests and requests inside an established HTTPS tunnel;
- pre-connection failover and post-connection failure;
- soft sticky and strict sticky sessions;
- stable logical node identity and configuration generation;
- saved, downloaded, parsed, validated, applied, ready, and healthy states;
- Node process liveness and Mihomo/runtime readiness;
- local CLI visibility and remote management API redaction.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly
rather than silently overriding it.

Use this form:

> Contradicts ADR-0007, but may be worth reopening because…
