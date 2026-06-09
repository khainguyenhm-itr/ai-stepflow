---
name: planing-from-github-issue
description: create planing from isue github link
---
# Plan from a GitHub Issue

Turn a GitHub issue link into a concrete, reviewable implementation plan. Do **not** write production code in this skill — produce a plan only.

## 1. Resolve the issue
- Read the issue URL the user provided. Parse `owner/repo` and issue number from it.
- Fetch the issue with the GitHub CLI:
  - `gh issue view <number> --repo <owner/repo> --json title,body,labels,assignees,comments,state`
- If the link is malformed or the issue can't be fetched, stop and ask the user for a valid link.
- Read the full body **and all comments** — requirements often shift in the discussion.

## 2. Understand the request
- Summarize in 1–3 sentences: what problem is being solved and the desired outcome.
- Extract explicit **acceptance criteria**. If none exist, infer them and mark as assumptions.
- Note labels (bug/feature/chore), linked issues/PRs, and any referenced files or errors.
- If the issue is ambiguous or underspecified, list the open questions and **ask the user before planning** rather than guessing.

## 3. Ground the plan in the codebase
- Locate the code areas the issue touches (search by symbols, file names, error strings from the issue).
- Identify affected files, entry points, and existing patterns/conventions to follow.
- Confirm the change is feasible as described; flag any conflicts with current architecture.

## 4. Write the plan
Produce a markdown plan with these sections:
- **Issue**: link, title, one-line summary.
- **Goal & acceptance criteria**: checklist the implementation must satisfy.
- **Assumptions & constraints**: state explicitly; call out anything unverified.
- **Affected files**: paths with a short note on the change each needs.
- **Implementation steps**: ordered, surgical, minimal — each step small enough to verify independently.
- **Tests / verification**: how each acceptance criterion will be confirmed (prefer automated tests).
- **Risks & open questions**: edge cases, rollout concerns, anything needing user input.

## Rules
- **Plan only** — no source edits unless the user explicitly asks to implement after reviewing.
- **Simplicity first**: smallest change that satisfies the criteria; no speculative scope.
- **Surgical**: touch only what the issue requires; no unrelated refactors.
- Keep the plan concise and skimmable; prefer bullets over prose.
- Present the plan and ask the user to confirm or adjust before any implementation begins.
