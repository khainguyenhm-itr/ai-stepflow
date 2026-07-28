# ClaudeSteps

**Run your Claude agents, skills, and multi-step workflows from inside VS Code** —
build a flow, run each step through the Claude CLI, and gate it on files or review.

![ClaudeSteps cockpit — building, running, streaming, and reviewing a two-step flow](images/cockpit-demo.gif)

## The idea

![How the pieces fit: agents + skills → step → flow → run with gates](images/concepts.png)

Compose reusable **agents** (*who* does the work) and **skills** (*how* — the
technique) into **steps**; wire steps into a **flow** (a dependency graph); then
**run** it — **gates** decide when each step is done. Agents and skills are just
markdown files in `~/.claude` (global) or `.claude` (per project).

## Features

- 🗂️ **One cockpit** — global and project agents, skills, and flows side by side.
- 🧩 **Visual flow builder** — agent + skills per step, set dependencies, drag to reorder.
- ▶️ **Step runner** — each step runs in a Claude terminal; output streams into the console.
- ✅ **Gates** — artifact (`requires` / `produces`) and review (human approve/reject or AI).
- 💾 **Run persistence** — in-progress runs are saved per project and restored on reload.
- 🖥️ **Headless CLI** — drive a flow from scripts or CI.
- 🔗 **GitNexus** *(optional)* — repo knowledge graph and multi-repo groups.

## Getting started

1. Install the Claude CLI: `npm install -g @anthropic-ai/claude-code`
2. Open the **ClaudeSteps** icon in the activity bar (or run **ClaudeSteps: Open Cockpit**).
3. Run **ClaudeSteps: Install Default Agents & Skills**, then press **+ New Flow** → **Run**.

## How a step runs

![Step lifecycle: Ready → run in terminal → produces check → review → Done](images/step-lifecycle.png)

A step opens an interactive Claude terminal (its agent + primary skill pre-filled).
It **starts** once its `dependsOn` steps are `done` and every `requires` file
exists; it **finishes** once every `produces` file/marker exists and the review
gate passes.

## Permissions and `trustLevel`

A flow declares `trustLevel: trusted` (the default) or `trustLevel: sandboxed`.

- **`trusted`** — steps run with Claude's normal permissions: interactive steps prompt as usual,
  headless steps auto-accept edits. Only run flows you trust, and review the diff.
- **`sandboxed`** — enforced on **both** paths:
  - `Bash`, `WebFetch` and `WebSearch` are **denied**. A deny rule beats any `allow`, including
    one in your own `.claude/settings.json`, and cannot be approved away at an interactive prompt.
  - The permission mode drops to `default`, so nothing is auto-accepted.
  - Only the step's declared `produces` (plus its `review.filePath`) are pre-approved for writing.
    Any other write still needs your explicit approval interactively, and has no prompt to satisfy
    headlessly — so it fails. A step that declares no artifacts can write nothing at all.

Two limits worth knowing: an unscoped `allow: ["Write"]`/`["Edit"]` already in your settings cannot
be revoked additively, so a blanket file-write allow stays in effect; and a custom agent
`runnerPath` receives the sandbox paths but is free to ignore them.

## CLI

The packaged extension exposes an `claudesteps` command for headless runs:

```sh
claudesteps run       --project . --flow .claude/flows/example.yaml --input feature=login
claudesteps verify    --project . --flow .claude/flows/example.yaml --run .claude-flow/runs/example-run.json
claudesteps report    --project . --flow .claude/flows/example.yaml --run .claude-flow/runs/example-run.json
claudesteps approve   --project . --flow .claude/flows/example.yaml --run .claude-flow/runs/example-run.json --step review
claudesteps mark-done --project . --flow .claude/flows/example.yaml --run .claude-flow/runs/example-run.json --step implement
```

`run` exits `3` at a human gate it cannot complete headlessly. `verify` re-checks
produced files against a saved run; `report` writes a markdown report.

## GitNexus *(optional)*

[GitNexus](https://www.npmjs.com/package/gitnexus) builds a per-repo knowledge
graph (symbols, call edges, flows) and can link repos into a group. Install it,
then a GitNexus row appears in **Project Settings**:

```sh
npm install -g gitnexus
claude mcp add gitnexus -- gitnexus mcp
```

## Commands

All commands live under the **ClaudeSteps** category in the Command Palette.

| Command | Description |
| --- | --- |
| `ClaudeSteps: Open Cockpit` | Open the cockpit |
| `ClaudeSteps: Refresh All` | Reload agents, skills, and flows from disk |
| `ClaudeSteps: Install Default Agents & Skills` | Install the bundled SDLC agents, skills, and rules into `~/.claude` |
| `ClaudeSteps: Rescan AST Graph` | Re-index the workspace with `ast-graph` |
| `ClaudeSteps: Re-register AST Graph MCP Server` | Re-register the `ast-graph` MCP server |

## License

MIT — see [LICENSE](./LICENSE).
