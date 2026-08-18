---
name: csf-skill-design
description: Draft a Technical Design Document. Focuses on architecture, data models, API specs, and tradeoffs.
tags: [engineering, design]
---
<!-- claudesteps built-in -->

Write a Technical Design Document (TDD) for the feature described in the input.

## Before writing
1. Read the PRD from Mandatory Input Files (if available).
2. Read relevant existing code to understand current patterns — do not design in a vacuum.
3. Read CLAUDE.md for project-specific conventions.

## Document structure (use these headings exactly)
1. **Overview** — one-paragraph summary of the proposed solution.
2. **Data Models** — schema definitions with field names, types, constraints, and relations.
3. **API Specification** — per endpoint: method, path, request body (typed fields), response (typed fields), error codes.
4. **Component Interactions** — sequence diagram (Mermaid) showing the main flow.
5. **Security Considerations** — authentication/authorization, input validation, secrets handling, attack surface.
6. **External Dependencies** — third-party services, APIs, or libraries introduced; version pinned where possible.
7. **Tradeoffs & Alternatives** — at least two alternatives considered, with explicit reasons for rejection.
8. **Migration / Rollout Plan** — DB migrations, feature flags, backward-compat notes, rollback procedure.

## Rules
- Follow existing project patterns; do not introduce new abstractions unless justified in Tradeoffs.
- Prefer simplicity — the simplest design that satisfies the PRD ACs wins.
- All field/endpoint names must be final (no placeholders).

Write to the path specified in Mandatory Output Files.

## Parallel fan-out
Independent work runs concurrently: dispatch one subagent per slice **in a single message**, then draw the conclusion yourself from their reports.

**Slice this by**: Surveying existing patterns — one subsystem, data store, or external dependency per slice.

- Independent slices only. Anything that depends on another slice's result stays sequential.
- Subagents investigate and report (findings + `file:line`); **you** do every write, so each Mandatory Output File keeps exactly one writer.
- Give each subagent its own explicit scope and ask for a compact report, not a file dump.
- Under a `sandboxed` flow subagents inherit the deny list (no Bash/WebFetch/WebSearch) — keep them read-only.
- One slice, or work you finish in two or three reads? Do it yourself — dispatching costs more than it saves.
