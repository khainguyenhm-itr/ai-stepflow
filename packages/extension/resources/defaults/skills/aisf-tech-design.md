<!-- ai-stepflow built-in -->
---
name: aisf-tech-design
description: Write or review a Technical Design — architecture, API/interface contracts, data model, state strategy, file impact, non-functional design, and rollout.
---

Write a Technical Design for the feature in the input, based on its PRD.

Read first: the PRD, the project's CLAUDE.md/README and architecture docs, the existing code in the affected area, and how dependencies are wired/registered.

Produce a design with these sections:
1. **Summary** — the approach in a few sentences.
2. **Architecture** — layer diagram, layer mapping, key choices with rationale.
3. **API / Interface Contract** — signatures or endpoints, request/response shapes, error codes, versioning, idempotency.
4. **Data Model** — schemas, migrations, indexes.
5. **State Management** — scope, lifecycle, synchronization, single source of truth.
6. **Sequence / Flow** — key interactions including error and retry paths.
7. **Dependency Wiring** — where new components are registered.
8. **NFRs** — performance budget (p50/p95), reliability, security/privacy, observability, accessibility, i18n, compatibility, offline.
9. **Rollout & Reversibility** — feature flags, staged rollout, rollback.
10. **File / Module Impact** — new / modified / deleted, with reasons.
11. **Risks & Open Questions**.

Apply the architecture rules: one-way layer boundaries, interfaces at every boundary, single source of truth for state, no hidden global state, resource safety, backward compatibility, feature flags for risky rollouts.

Output: write the design to `docs/<feature>/TECH-DESIGN.md`.
