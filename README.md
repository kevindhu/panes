<p align="center">
  <img src="app-icon.svg" alt="Panes" width="128" height="128" />
</p>

<h1 align="center">Panes</h1>

<p align="center">
  A focused desktop client for OpenAI Codex.
</p>

Panes keeps Codex conversations tied to local workspaces in a fast, native desktop app. It is local-first and intentionally centered on one workflow: working with Codex across your projects.

## Features

- Local workspaces with persistent Codex threads
- Streaming transcripts for messages, reasoning, tool calls, diffs, and approvals
- Plan mode, attachments, model selection, and reasoning controls
- Thread search, branching, rollback, archive, and compaction
- Markdown, syntax highlighting, local file links, and image previews
- SQLite-backed local history

## Install

Panes requires [Codex CLI](https://github.com/openai/codex) `0.150.1` or newer.

### macOS

```bash
brew install --cask kevindhu/tap/panes
```

Panes is not currently signed and notarized. If macOS blocks the first launch, open it through Finder's **Open** action.

### Windows and Linux

Download the latest installer, `.deb`, or AppImage from [GitHub Releases](https://github.com/kevindhu/panes/releases/latest).

## Run from source

You will need Node.js 20+, pnpm 9+, Rust stable, and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
git clone https://github.com/kevindhu/panes.git
cd panes
pnpm install
pnpm tauri:dev
```

Useful checks:

```bash
pnpm test
pnpm typecheck
pnpm check:codex-schema
```

Panes uses React, TypeScript, Zustand, Tauri, Rust, and SQLite.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
