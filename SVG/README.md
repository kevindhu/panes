# Icon versions

- `panes-original.svg`: original stacked white panes and glowing green center.
- `panes-two-pane.svg`: chamfered two-pane design with outlined panes.
- `panes-two-pane-filled.svg`: solid electric-green front pane.
- `panes-two-pane-filled-soft.svg`: slightly softened solid green front pane; current test icon.
- `panes-p-flat.svg`: large slanted P without shadows.
- `panes-p-shadow.svg`: large slanted P with subtle shadows.

The active copies are `../app-icon.svg` (also used by the repository README) and
`../src-tauri/icons/icon.svg`. Platform assets are generated from the active SVG
with `pnpm exec tauri icon app-icon.svg`; `app-icon.png` mirrors the generated
`src-tauri/icons/icon.png`. These archived SVGs preserve each design for reuse.
