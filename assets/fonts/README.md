# Vellum fonts

Two open-source families are bundled locally so the panel renders identically
offline. Both are licensed under the SIL Open Font License, Version 1.1.

## Newsreader (display serif)

- Files: `newsreader-latin-400-normal.woff2`, `newsreader-latin-400-italic.woff2`,
  `newsreader-latin-500-normal.woff2`
- Subset: latin, WOFF2
- Source: `@fontsource/newsreader@5` (npm), files mirrored from jsDelivr
- Upstream: https://github.com/productiontype/Newsreader
- Copyright: 2020 The Newsreader Project Authors
- License: SIL Open Font License 1.1 — see `LICENSE-Newsreader.txt`

## Instrument Sans (interface sans)

- Files: `instrument-sans-latin-400-normal.woff2`,
  `instrument-sans-latin-500-normal.woff2`, `instrument-sans-latin-600-normal.woff2`
- Subset: latin, WOFF2
- Source: `@fontsource/instrument-sans@5` (npm), files mirrored from jsDelivr
- Upstream: https://github.com/Instrument/instrument-sans
- Copyright: 2022 The Instrument Sans Project Authors
- License: SIL Open Font License 1.1 — see `LICENSE-InstrumentSans.txt`

## Notes

- The panel references these files from `src/renderer/panel/panel.css` via
  `../../../assets/fonts/...`, so the `assets/fonts` folder must ship with the app.
- Only the latin subset is included. Adding another script means adding the
  matching `@fontsource` subset files and `@font-face` blocks.
- OFL permits bundling and embedding in applications; keep the license files
  next to the fonts and do not sell the fonts on their own.
