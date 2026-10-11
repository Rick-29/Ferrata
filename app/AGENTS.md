# figma-make-app

React + Vite + Tailwind CSS project running inside Figma Make.

## Development Server

A Vite development server is **already running** on `$PORT` (default 8443). You don't need to start it manually.

- Preview URL: The user can access the running app through the preview panel
- Hot reload: Changes to source files are reflected immediately

## Project Structure

This is the canonical project structure. Start with task-relevant files below. Only follow imports or inspect other files when required, when a documented path is missing, or when the repository contradicts this guide.

- `src/main.tsx` - React entrypoint; imports `src/index.css` and mounts `src/App.tsx` into the `#root` element
- `src/App.tsx` - Primary application component and the usual starting point for UI work
- `src/index.css` - Global CSS entrypoint and Tailwind CSS v4 import
- `index.html` - Vite HTML shell containing the `#root` element and loading `src/main.tsx`
- `package.json` - Project dependencies and the Vite build, development, preview, and formatting scripts
- `vite.config.ts` - Vite configuration with React, Tailwind CSS v4, and Figma Make plugins plus the `@` alias for `src`
- `.mise.toml` - Toolchain versions for Node.js and pnpm

## Dependencies

- Runtime: React 19 and React DOM 19
- Styling: Tailwind CSS v4 with the `@tailwindcss/vite` plugin
- Build tooling: Vite 8, TypeScript 5.7, and `@vitejs/plugin-react`
- Formatting: oxfmt

## Styling

This project uses **Tailwind CSS v4** through the `@tailwindcss/vite` plugin configured in `vite.config.ts`. `src/index.css` imports Tailwind with `@import 'tailwindcss';`. Use Tailwind utility classes directly in JSX and put global CSS or Tailwind v4 theme customization in `src/index.css`. This scaffold does not need a Tailwind config file or PostCSS config.

`src/main.tsx` imports `src/index.css`, so global font wiring belongs in `src/index.css`. Keep CSS `@import` statements first, then add any `@font-face` rules and font-family defaults there.

## Code quality

- Use double quotes for strings containing apostrophes (`"We're here to help"`), or escape them in single-quoted strings. An unescaped apostrophe in a single-quoted string breaks the build.
- Ensure JSX tags are closed and braces are balanced.
- Export components as default exports.

## Ferra Visualizer (the real app)

- `src/App.tsx` — shell: Open screen → Validation report (Automatic) ↔ Chain canvas (Manual).
- `src/lib/ferra.ts` — typed bridge to the Tauri backend in `src-tauri` (see its README). Outside
  the desktop window it falls back to `src/lib/mock.ts`, which serves `public/mock/*.json`
  (regenerate with `cd src-tauri && cargo test -- --ignored dump_mock`).
- `src/lib/graphStore.ts` — the manual-mode graph: nodes are `network:address`, edges bundle the
  transfers per direction, each expansion lays its neighbours out in columns beside the expanded
  node (newest first, or by risk / amount), wrapping every 12 rows. Dragged nodes stay put until
  "Re-layout".
- `src/components/ChainCanvas.tsx` — React Flow canvas with two views: Timeline (default: the
  chain's validatable events left to right in chain order, `EventNode.tsx` / `EventPanel.tsx`,
  animated stream, Ferra-only toggle) and Graph (pan, zoom, drag, minimap, online/offline toggle).
  Search covers canvas nodes, chain counterparties not yet on the canvas, and event hashes. One edge per pair of addresses: `FloatingEdge.tsx` draws it rim to rim,
  payer to payee, a head at both ends when money went both ways, dashes animated toward the
  receiver (blue = leaving a wallet under review, red = entering one, violet = wallet to wallet,
  grey = other). `NodePanel.tsx` / `EdgePanel.tsx` are the side panels; `AddressNode.tsx` the
  bubble (fill = network from `src/lib/networks.ts`, ring = risk verdict). Theme: `data-theme` on
  `<html>`, light overrides at the end of `src/index.css`.
- Run: `pnpm tauri dev` for the desktop app, `pnpm dev` for the browser preview on fixtures.
- Do not run `pnpm format`: oxfmt 0.2 drops the `;` inside one-line TypeScript type literals and
  breaks the build.
