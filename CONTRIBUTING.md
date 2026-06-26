# Contributing to AI StepFlow

Thanks for your interest in improving AI StepFlow. This is a VS Code extension
monorepo (`packages/core`, `packages/extension`, `packages/webview`) built with
TypeScript and esbuild.

## Engineering principles

This project follows the **Karpathy Rules** documented in [`CLAUDE.md`](./CLAUDE.md):
think before coding, prefer the minimum change, keep edits surgical, and verify
against tests. Please read them before opening a PR.

## Prerequisites

- Node.js `>=20` (see [`.nvmrc`](./.nvmrc))
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) on your `PATH`
  (`npm install -g @anthropic-ai/claude-code`) — required to run flows

## Setup

```sh
npm ci
npm run compile        # build all workspaces + bundle the extension
```

## Develop

- `npm run watch` — rebuild extension on change
- `npm run watch-webview` — rebuild the React webview on change
- Press `F5` in VS Code to launch the Extension Development Host

## Before you open a PR

Run the same checks CI runs:

```sh
npm run lint           # eslint, must be clean
npm test               # unit + webview tests
npm run test:coverage  # core coverage gate (lines 85% / branches 70% / functions 70%)
```

Integration tests (headless VS Code) run in CI via `npm run test:integration`.

## Pull requests

- Branch off `main`; keep the change focused on one logical unit.
- Add or update tests for behavior changes — `packages/core` is the
  business-logic layer and should stay well covered.
- Keep commits atomic with clear messages.
- Fill in the PR template checklist.

## Reporting bugs / requesting features

Use the issue templates under **New issue**. For security issues, do **not** open
a public issue — see [`SECURITY.md`](./SECURITY.md).
