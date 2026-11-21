# dsh-image-formats

[![CI](https://github.com/TLEWA/dsh-image-formats/actions/workflows/ci.yml/badge.svg)](https://github.com/TLEWA/dsh-image-formats/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-image-formats.svg)](https://www.npmjs.com/package/dsh-image-formats)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[简体中文](README.md) · [English](README.en.md)

Make [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) `read_image` and the composer accept
**AVIF / TIFF / SVG** directly, converting to PNG when needed and then handing the result to the
existing attachment and upload paths.

Stock DSH accepts PNG, JPEG, WebP and GIF only. AVIF is rejected by the client before upload, and
`read_image` rejects AVIF/TIFF/SVG by extension. This plugin edits neither `app.asar` nor adds a
runtime dependency: the host half prefers the Sharp/libvips bundled with DSH desktop and falls back
to a Sharp installed in a DSH profile when the CLI has none, while the client half reuses the
browser decoder and canvas.

## What it changes

| Entry point | Stock DSH | With this plugin |
| --- | --- | --- |
| Paste / drop / pick an AVIF in the composer | rejected before upload | browser converts to PNG, then the official upload path runs |
| `read_image` on AVIF | rejected by extension or byte sniff | Sharp converts to PNG and returns it as an image attachment |
| `read_image` on TIFF | rejected | Sharp converts to PNG |
| `read_image` on SVG | rejected | Sharp/libvips renders it to PNG |
| PNG / JPEG / WebP / GIF | works | passed through untouched |
| HEIC / HEIF / JXL / PSD / RAW | rejected | explicit, actionable error instead of guessing |

## Two halves

### Host: a same-name `read_image` shadows the global tool

On `agent/created` the plugin registers a `read_image` in every agent scope through
`agent.ctx.tools.register`. Agent-scoped tools shadow the global definition, so the model still sees
one familiar `read_image`, backed by this implementation. Agents that already exist when the plugin
loads are registered too.

Execution mirrors the official tool:

1. validate `file_path` and classify it by extension;
2. check the deployment attachment allow-list and whether the calling route declares `image` input;
3. resolve and read through `ctx.fs`, capped by the smaller of `maxImageBytes` and
   `maxMessageImageBytes`;
4. store direct formats (PNG/JPEG/WebP/GIF) as-is; convert AVIF/TIFF/SVG to PNG with Sharp first;
5. call `attachments.saveImage`, return the same `{ path, image }` shape, and emit `fs/observed`.

Conversion uses the Sharp bundled with DSH or installed in a profile:

- `limitInputPixels: 268435456`, `failOn: 'none'`, first frame only;
- SVG is rendered at `density: 144`; other formats are auto-rotated from EXIF orientation;
- PNG output uses `compressionLevel: 9`; `photo.avif` becomes `photo.png`;
- when Sharp cannot be loaded the tool throws a diagnosable `IMAGE_CONVERTER_UNAVAILABLE` instead
  of guessing a format.

Sharp candidates, in order: the `DSH_IMAGE_FORMATS_SHARP` environment variable,
`app.asar/dsh/node_modules/sharp` and `app.asar/node_modules/sharp` under `process.resourcesPath`,
the same `resources/...` paths next to the executable, `<DSH_HOME>/profiles/<profile>/node_modules/sharp`
(the active profile first, then the others; `~/.dsh` is used when `DSH_HOME` is unset), and finally a
plain `sharp`. The copy bundled with DSH desktop normally matches one of the first candidates; the
CLI ships no Sharp, so a profile with Sharp installed is required there.

### Client: replace the file before it reaches the composer

The client plugin listens at capture phase on `paste`, `drop` and `change`:

1. select AVIF only (MIME `image/avif`, or a `.avif` name with no other declared type);
2. decode with `createImageBitmap`, falling back to `<img>` plus an object URL;
3. draw to canvas with a 2048 px long edge and encode with `canvas.toBlob('image/png')`; if the PNG
   is over 6MB, shrink toward 1024 px and retry;
4. hand the PNG to the host's public `conversation.input.attachments` slot through its
   `onAddFiles` owner prop, so the official `intakeFiles` upload path runs; only when the host has no
   such slot does it fall back to the old DOM route — write the PNG back into the hidden
   `input[type=file][hidden]` in the composer with `DataTransfer` and dispatch a bubbling `change`.

That slot is a single cell: registering in it shadows the host's own attachment rail, which has no
public rebuild entry. The bridge is therefore mounted only while the cell is empty and retracts as
soon as another entry appears (a stock rc.5 install has the host's own rail there), so the plugin
keeps the DOM write-back and the host UI is unchanged. If the slot service arrives after the plugin,
the plugin waits for `internal/service` and attaches once.

The official InputBar `onPickFiles` / `intakeFiles` path then handles the PNG normally; the plugin
does not call any private upload function. Conversion stays in memory — no temporary file and no
network request.

If a paste also carries non-empty `text/plain`, the plugin leaves the event to native handling so
text is not swallowed.

## Install

Requirements:

- DSH `0.2.1-rc.5` or newer, below `0.3.0`;
- Node.js `20` or newer (the plugin adds no dependencies; the DSH CLI needs Sharp from a profile
  or the environment, while desktop bundles it).

### From npm (after release)

Sidebar **Plugins** → **Install plugin**, enter:

```text
dsh-image-formats
```

Or:

```powershell
dsh plugin --profile desktop add dsh-image-formats
```

### From GitHub

```text
https://github.com/TLEWA/dsh-image-formats
```

Pinned to a tag:

```powershell
dsh plugin --profile desktop add github:TLEWA/dsh-image-formats#v0.1.0
```

### From source

```powershell
git clone https://github.com/TLEWA/dsh-image-formats.git
cd dsh-image-formats
npm test
dsh plugin --profile desktop add .
```

Restart DSH after installing: host plugins load when the profile starts, and the client plugin takes
effect after the Web UI refreshes.

## Compatibility and limitations

- **No HEIC/HEIF**: the Sharp/libvips bundled with DSH desktop has no HEVC decoder (it needs libde265), so
  even a converted HEIC cannot be read. The plugin reports `HEIC/HEIF (HEVC)` and suggests converting
  to AVIF/PNG/JPEG/WebP first;
- **No JPEG XL, PSD or camera RAW**: Sharp has no decoder for them;
- the client converts **AVIF only**. Browsers have no stable TIFF decoder, and SVG through canvas
  raises cross-origin/security questions, so dropping TIFF/SVG is still rejected by the official
  upload path; reading those paths with `read_image` is unaffected;
- the client half prefers the host's public `conversation.input.attachments` slot; while that cell
  is occupied (a stock DSH install) it falls back to the composer's hidden file input and the
  `data-composer-card` marker. A DSH layout change that removes either needs a plugin update;
- conversion keeps the first frame only: AVIF/TIFF animation or multi-page content is not carried
  over;
- conversion re-encodes: EXIF, ICC/HDR and 10-bit data may be lost or changed, and PNG can be larger
  than the original AVIF;
- the source file is never modified; the session receives a new PNG attachment;
- the host gate matches the official tool: the calling route must declare `image` input, otherwise
  `IMAGE_UNSUPPORTED_MODEL` is reported before any file is read;
- the first conversion reads the whole image into memory, bounded by DSH attachment byte limits.

## Development and tests

```powershell
npm run check   # node --check lib/index.js && node --check lib/client.js
npm test        # node --test test/host.test.js test/client.test.js
```

Coverage:

- `test/host.test.js`: registration and de-duplication, standard JSON Schema shape, AVIF/TIFF/SVG
  conversion, direct passthrough, extension-less AVIF sniffing, HEIC refusal, unknown
  extension/empty argument, a route without image input, missing Sharp and conversion failure;
- `test/client.test.js`: loads the client bundle through `node:vm`, checks the ModuleLoader id,
  `inject`, the three capture listeners installed by `apply`, and cleanup through `ctx.effect`.

Manual regression: upload an AVIF through paste, drop and the file picker in the DSH Web UI and
confirm the composer receives a PNG; then point the model at an AVIF/TIFF/SVG path, call
`read_image`, and confirm the attachment media type is `image/png`.

## Other DSH projects I work on

- **[dsh-sidebar-row-menu](https://github.com/TLEWA/dsh-sidebar-row-menu)** — right-click menus for sidebar workspace and session rows.
- **[dsh-sidebar-organizer](https://github.com/TLEWA/dsh-sidebar-organizer)** — drag-to-arrange layout for seven regions.
- **[dsh-better-choice](https://github.com/TLEWA/dsh-better-choice)** — notes and side questions for `ask_user_question`.
- **[dsh-if](https://github.com/TLEWA/dsh-if)** — the `/if` conditional command.
- **[dsh-opencode-go-router](https://github.com/TLEWA/dsh-opencode-go-router)** — OpenCode Go routing after context folds.
- **[dsh-fastload](https://github.com/TLEWA/dsh-fastload)** — trims the first history page of long sessions.
- **[dsh-ptc-noargs](https://github.com/TLEWA/dsh-ptc-noargs)** — normalizes argument-less PTC `run_code` tool calls.
- **[dsh-ps51-guard](https://github.com/TLEWA/dsh-ps51-guard)** — a guard for PowerShell 5.1 calls.
- **[dsh-utf8-output](https://github.com/TLEWA/dsh-utf8-output)** — fixes GBK/CP936 subprocess output on Windows.

## License

MIT © 2026 TLEWA

## Codex PR review

This repository adopts the v1 shared review block in AGENTS.md from
[central CI](https://github.com/TLEWA/dsh-plugin-ci). Cloud Codex reviews PRs and new commits;
maintainers retain final approval and merging. Review results must cover the latest commit. Review
consumes subscription usage; use `@codex review` for missing results.
