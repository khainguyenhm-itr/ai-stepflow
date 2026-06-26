# AI StepFlow Project Guidelines

This project follows **Karpathy's Rules** for high-standard engineering and agentic workflows. All AI agents (including the one managing this repo) must adhere to these principles.

## Karpathy's Core Rules

### 1. Think Before Coding
- **Strategy:** Explicitly state assumptions, identified constraints, and architectural tradeoffs before modifying any code.
- **Ambiguity:** If a request is underspecified, stop and ask the user for clarification rather than making guesses.

### 2. Simplicity First
- **Bias:** Always prefer the absolute minimum code required to solve the problem.
- **Abstractions:** Avoid "just-in-case" abstractions or speculative features. Keep the codebase lean and maintainable.

### 3. Surgical Changes
- **Scope:** Only touch the files and lines strictly necessary for the current task.
- **Discipline:** Do not perform unrelated refactoring, formatting changes in adjacent files, or "cleanups" unless specifically requested.

### 4. Goal-Driven Execution
- **Verification:** Every change must be verified against clear success criteria (preferably automated tests).
- **Iteration:** Loop until the specific goals are met and behavioral correctness is confirmed.

---

*Note: When the default library is installed, the extension (`ConfigManager.ensureProjectClaudeMd` in `packages/extension/src/configManager.ts`) merges these rules into the project's `CLAUDE.md` inside `ai-stepflow:karpathy` markers, so every Claude Code run in the project — including steps launched from AI StepFlow — picks them up.*

## Engineering Discipline (Karpathy Rules)
- **Think Before Coding**: State assumptions and tradeoffs explicitly before implementation.
- **Simplicity First**: Bias toward minimum code. No speculative features or over-engineering.
- **Surgical Changes**: Only modify files and lines strictly necessary. No unrelated refactors.
- **Goal-Driven**: Fulfill success criteria and ensure results are verifiable.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **ai-stepflow** (2349 symbols, 4351 relationships, 202 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/ai-stepflow/context` | Codebase overview, check index freshness |
| `gitnexus://repo/ai-stepflow/clusters` | All functional areas |
| `gitnexus://repo/ai-stepflow/processes` | All execution flows |
| `gitnexus://repo/ai-stepflow/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
