# opencode-prompt-enhancer

OpenCode TUI plugin that rewrites rough prompt drafts into stronger prompts with workspace context.

## Package

- npm: `opencode-prompt-enhancer`
- GitHub: `mtayfur/opencode-prompt-enhancer`

## Install

Add the package to OpenCode's `tui.json` plugin list:

```jsonc
{
  "plugin": [
    "opencode-prompt-enhancer@latest"
  ]
}
```

## Use

After restarting OpenCode, press `Ctrl+E` or run `/enhance`.

The plugin opens a dialog, rewrites your draft with workspace context, and writes the enhanced prompt back into the current input.

## Context

The enhancer uses the current working directory, branch, recent user prompts, changed files, and active todos. It passes lightweight context only and does not read file contents.

## Development

```bash
bun install
bun run typecheck
```
