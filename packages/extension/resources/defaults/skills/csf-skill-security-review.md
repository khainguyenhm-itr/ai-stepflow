---
name: csf-skill-security-review
description: Threat-model a change and audit it for exploitable vulnerabilities, with prioritized remediation.
tags: [security, review]
---
<!-- claudesteps built-in -->

Audit the change for real, exploitable security weaknesses. Depth over breadth — a confirmed Critical beats ten speculative notes.

## Before reviewing
- Read the PRD/TDD from Mandatory Input Files to learn trust boundaries, inputs, and data sensitivity.
- Read the changed code and its callers; identify where untrusted input enters and where sensitive data or actions exit.

## 1. Threat model
List the trust boundaries this change touches, the untrusted inputs crossing them, and the assets at risk (PII, credentials, funds, integrity).

## 2. Audit checklist
- **Injection**: SQL/NoSQL, OS command, template, path traversal, SSRF, unsafe deserialization.
- **AuthN/AuthZ**: missing/incorrect checks, IDOR, privilege escalation, broken session or token handling.
- **Secrets & data**: hardcoded secrets, secrets in logs/responses, over-broad output, missing encryption at rest/in transit.
- **Web surface**: XSS (stored/reflected/DOM), CSRF, open redirect, insecure CORS, missing security headers.
- **Dependencies & config**: known-vulnerable or unpinned packages, insecure defaults, debug endpoints left enabled.

## 3. Findings
```
[CRITICAL | HIGH | MEDIUM | LOW] <title>
Location: <file>:<line>
Threat: <attack path and impact>
Fix: <specific, minimal remediation>
```
Rank by exploitability × impact. For each Critical/High, give a concrete exploitation sketch so the risk is undeniable.

## Rules
- Only report issues you can justify with the code in front of you. Do not pad with generic best-practice reminders unless this change introduces the gap.
- If there are no Critical or High findings, state that explicitly.

Write to the path specified in Mandatory Output Files.

## Parallel fan-out
Independent work runs concurrently: dispatch one subagent per slice **in a single message**, then draw the conclusion yourself from their reports.

**Slice this by**: Each audit-checklist category — injection, authN/authZ, secrets & data, web surface, dependencies & config.

- Independent slices only. Anything that depends on another slice's result stays sequential.
- Subagents investigate and report (findings + `file:line`); **you** do every write, so each Mandatory Output File keeps exactly one writer.
- Give each subagent its own explicit scope and ask for a compact report, not a file dump.
- Under a `sandboxed` flow subagents inherit the deny list (no Bash/WebFetch/WebSearch) — keep them read-only.
- One slice, or work you finish in two or three reads? Do it yourself — dispatching costs more than it saves.
