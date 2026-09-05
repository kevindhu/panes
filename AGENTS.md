# AGENTS.md

## Project context

Panes is a local-first desktop client for Codex, using React, TypeScript, Zustand, Tauri, Rust, and SQLite.

- `src/components/`: chat UI and Codex workspace components.
- `src/stores/`: Zustand state and coordination with the backend.
- `src/lib/`: frontend IPC helpers, transcript projection, and runtime selection.
- `src-tauri/src/commands/`: Tauri commands exposed to the frontend.
- `src-tauri/src/engines/`: Codex app-server transport, protocol handling, and event mapping.
- `src-tauri/src/db/`: SQLite persistence and migrations.
- `src/i18n/resources/en/`: English UI strings; update these when changing user-facing copy.

Reuse existing IPC and store patterns. Before changing transcript capture, projection, persistence, replay, or forks, read [the transcript architecture contract](docs/architecture/codex-transcript-v2.md). Preserve native events, authoritative completed items, and consistent live/reloaded rendering.

## Verification

Choose checks based on the changed behavior. Complete the relevant checks, then broaden them only for a concrete unresolved concern. Report what was checked and any remaining gaps.

- Documentation-only changes: verify accuracy and referenced paths; no app build or test suite is needed.
- Frontend logic: run `pnpm typecheck` and affected tests with `pnpm exec vitest run <test-file>`. Add or update regression tests for changed behavior when needed.
- Visible UI changes: inspect the affected flow in the running `pnpm tauri:dev` app, in addition to checks appropriate to the code change.
- Rust changes: from `src-tauri`, run `cargo fmt -- --check`, `cargo check --locked`, and relevant tests with `cargo test --locked --lib <test-filter>`.
- Codex protocol changes: run `pnpm check:codex-schema` against the installed CLI and the affected protocol/transcript replay tests. Preserve raw fallback handling for unknown events.
- Shared or cross-layer changes may require broader frontend and Rust tests. Desktop packaging is not a routine verification step.

## Development and explicitly requested Windows builds

`<repo>` below means the absolute path to this checkout's root.

- Do not try to create a build `.exe` unless the user manually and explicitly tells you to.
- Do not run build/package commands such as `pnpm tauri:build` unless the user manually and explicitly asks for that.
- Do not treat building the desktop app as the default validation step for normal changes.
- After a big change, always recommend that the user restart the dev server currently running via `pnpm tauri:dev`.
- Treat "big change" broadly: substantial UI changes, app logic changes, Tauri changes, config changes, or dependency changes.
- Prefer the running `pnpm tauri:dev` workflow for normal iteration unless the user explicitly asks for a build.
- If the user explicitly asks for a new Windows binary and does not specifically request a release build or installer, create a cached development executable with:
  `pnpm build:dev-exe -- <build-suffix>`
- The development build helper uses the debug profile, reuses the absolute Cargo cache at:
  `<repo>\src-tauri\target-dev-cache`
- It copies the finished executable to:
  `<repo>\src-tauri\target-build-<build-suffix>\debug\Panes.exe`
- It also creates the required Start Menu shortcut automatically. Do not separately recreate that shortcut.
- Never launch or create a shortcut to the cached executable itself. Only launch the copied executable so Windows cannot lock the shared compiler output.
- Cached development executables are debug builds without an installer. Codex functionality requires an installed Codex CLI; these builds are not release artifacts.
- Only use a fresh custom release target directory when the user explicitly asks for a release build or installer.
- On Windows, never use a relative `CARGO_TARGET_DIR` like `src-tauri/target-feature-name`; Tauri runs from `src-tauri`, so that can land in `src-tauri/src-tauri/target-feature-name`. Use an absolute path instead.
- For an explicitly requested custom release build, run from the repo root in PowerShell:
  ```powershell
  $env:CARGO_TARGET_DIR = Join-Path (Get-Location).Path 'src-tauri/target-feature-name'
  pnpm tauri:build
  ```
- Expected artifacts for that pattern:
  `<repo>\src-tauri\target-feature-name\release\Panes.exe`
  `<repo>\src-tauri\target-feature-name\release\bundle\nsis\Panes_<version>_x64-setup.exe`
- After creating a requested Windows binary, also create a Start Menu shortcut so the build is easy to launch from Windows search.
- Put those shortcuts in:
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Panes Builds\`
- Name each shortcut after the build suffix, for example:
  `Panes-7-10-3.lnk`
- Do not delete older build shortcuts unless the user explicitly asks.
- `pnpm tauri:build` can still exit nonzero after producing the `.exe` and installer because updater signing fails when `TAURI_SIGNING_PRIVATE_KEY` is unset. Check the artifact paths before assuming the build failed.
- Custom `target-*` folders are local build artifacts. Do not commit them.
