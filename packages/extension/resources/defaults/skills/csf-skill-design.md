---
name: aisf-skill-design
description: Draft a Technical Design Document. Focuses on architecture, data models, API specs, and tradeoffs.
tags: [engineering, design]
---
<!-- ai-stepflow built-in -->

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
