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
