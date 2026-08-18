---
name: csf-skill-review
description: Perform a technical review of code or designs. Focuses on quality, security, and standards.
tags: [engineering, review]
---
<!-- claudesteps built-in -->

Review the provided code or design across the dimensions below. For each finding, assign a severity and provide a specific, actionable suggestion.

## Severity levels
- **Critical** — must fix before merge: correctness bugs, security vulnerabilities, data loss risks.
- **Major** — should fix before merge: missing edge case handling, significant performance issue, broken AC.
- **Minor** — fix when convenient: style, naming, minor duplication.

## Review dimensions
1. **Correctness** — does it meet all PRD acceptance criteria? Are there logic bugs or missing cases?
2. **Security** — check for XSS, SQL/command injection, CSRF, auth/authz bypass, secret exposure, insecure dependencies.
3. **Performance** — unnecessary re-renders, N+1 queries, blocking I/O, missing pagination, unbounded loops.
4. **Standards** — follows project style (CLAUDE.md), consistent naming, no dead code.
5. **Maintainability** — readable, testable, adequately decoupled; no over-engineering.
6. **Edge Cases** — null/undefined inputs, empty collections, concurrent access, network failure paths.

## Before reviewing
- Read the PRD ACs from Mandatory Input Files if available — verify the code satisfies each one.

## Output format
```
## Review Summary
- Critical: N  Major: N  Minor: N

## Findings
### [CRITICAL | MAJOR | MINOR] <short title>
**File/Location**: <file>:<line>
**Problem**: <what is wrong and why it matters>
**Suggestion**: <specific fix>
```

Prioritize Critical findings first. If there are no Critical or Major findings, say so explicitly.

## Parallel fan-out
Independent work runs concurrently: dispatch one subagent per slice **in a single message**, then draw the conclusion yourself from their reports.

**Slice this by**: Each review dimension — correctness, security, performance, standards, maintainability, edge cases.

- Independent slices only. Anything that depends on another slice's result stays sequential.
- Subagents investigate and report (findings + `file:line`); **you** do every write, so each Mandatory Output File keeps exactly one writer.
- Give each subagent its own explicit scope and ask for a compact report, not a file dump.
- Under a `sandboxed` flow subagents inherit the deny list (no Bash/WebFetch/WebSearch) — keep them read-only.
- One slice, or work you finish in two or three reads? Do it yourself — dispatching costs more than it saves.
