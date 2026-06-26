## Install the Claude Code CLI

AI StepFlow runs each step through the local **`claude`** CLI. Install it once,
globally:

```sh
npm install -g @anthropic-ai/claude-code
```

Then confirm it is on your `PATH`:

```sh
claude --version
```

If `claude` is not found, AI StepFlow will tell you in the step output instead of
failing silently.
