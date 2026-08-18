---
name: csf-skill-document
description: Write or update user- and developer-facing documentation (README, usage guides, API docs, changelog).
tags: [docs]
---
<!-- claudesteps built-in -->

Document the feature or change accurately and only from what the code and inputs actually support.

## Before writing
1. Read the PRD, TDD, and implementation notes from Mandatory Input Files if available.
2. Read the actual code being documented — every described behavior, signature, flag, and example must match the implementation. Never document intended behavior that the code does not yet have.

## What to produce (pick what the task needs — do not pad)
- **README / overview**: what it does, when to use it, how to install/run, a minimal working example.
- **Usage guide**: common tasks step by step, with copy-pasteable commands or code.
- **API / reference**: each public function/endpoint — signature, parameters with types, return value, errors, one example.
- **Changelog entry**: user-visible changes grouped as Added / Changed / Fixed / Removed; note any breaking change and its migration.

## Rules
- Accuracy over completeness — a correct short doc beats a long one with stale claims.
- Every code example must be runnable as written (correct names, imports, arguments).
- Match the existing docs' structure, tone, and formatting conventions (per CLAUDE.md). Do not invent a new docs style.
- No placeholders, `TODO`, or `lorem ipsum`. If a detail is genuinely unknown, ask rather than fabricate.

Write to the path specified in Mandatory Output Files.

## Parallel fan-out
Independent work runs concurrently: dispatch one subagent per slice **in a single message**, then draw the conclusion yourself from their reports.

**Slice this by**: Surveying what to document — one public surface per slice (module, endpoint group, CLI command set).

- Independent slices only. Anything that depends on another slice's result stays sequential.
- Subagents investigate and report (findings + `file:line`); **you** do every write, so each Mandatory Output File keeps exactly one writer.
- Give each subagent its own explicit scope and ask for a compact report, not a file dump.
- Under a `sandboxed` flow subagents inherit the deny list (no Bash/WebFetch/WebSearch) — keep them read-only.
- One slice, or work you finish in two or three reads? Do it yourself — dispatching costs more than it saves.
