---
name: aisf-skill-debug
description: Diagnose a reported bug to root cause, then apply the smallest correct fix with a regression test.
tags: [engineering, debugging]
---
<!-- ai-stepflow built-in -->

Find the root cause of the reported bug before changing any code. Do not patch symptoms.

## Steps
1. **Reproduce** — establish a reliable, minimal reproduction. State the exact steps, inputs, and observed vs. expected behavior. If you cannot reproduce, say so and list what you need.
2. **Read inputs** — read any bug report, issue, or upstream artifact from Mandatory Input Files. Read the failing code and its callers before forming a hypothesis.
3. **Locate root cause** — form one hypothesis at a time and confirm it with evidence (logs, a failing test, narrowing the input). Name the exact line(s) and the mechanism. Distinguish root cause from symptom.
4. **Write a failing test first** — add a test that fails because of the bug, proving the diagnosis. If the area is untested, add the minimal harness needed.
5. **Fix minimally** — apply the smallest change that addresses the root cause. No unrelated refactors or drive-by changes.
6. **Verify** — the new test passes, the full existing suite still passes, and the original reproduction no longer reproduces.

## Rules
- Root cause must be evidence-backed, not guessed. If multiple causes are plausible, list them and how you ruled each out.
- A fix without a regression test is incomplete unless the area is genuinely untestable (state why).
- Note any other code paths affected by the same root cause.

## Output
```
## Bug Diagnosis
**Symptom**: <observed behavior>
**Root cause**: <file>:<line> — <mechanism>
**Fix**: <what changed and why it resolves the root cause>
**Regression test**: <test name / location>
**Verification**: <suite result + reproduction now passes>
```

Write to the path specified in Mandatory Output Files.
