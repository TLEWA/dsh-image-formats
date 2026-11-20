# Changelog

## [0.1.0] - 2026-11-20

First release.

- Added a same-name host `read_image` that shadows the official tool in each agent scope and converts
  AVIF/TIFF/SVG to PNG before the existing attachment service sees them. PNG/JPEG/WebP/GIF pass
  through untouched; extension-less files are identified by signature.
- Reuses the Sharp/libvips bundled with DSH desktop; the CLI has no bundled Sharp, so an installed
  copy is discovered in the active profile first and then other profiles. No `app.asar` edit and no
  new runtime dependency; missing Sharp or a failed conversion produces a diagnosable error code.
- HEIC/HEIF is refused explicitly: the bundled libvips has no HEVC decoder, so the plugin suggests
  converting to AVIF/PNG/JPEG/WebP first. JXL, PSD and camera RAW are likewise out of scope.
- The client intercepts AVIF on paste, drop and file picking at capture phase, decodes it in the
  browser, encodes PNG, and writes it back into the composer's hidden file input so the official
  `intakeFiles` upload path still runs. Long edge is capped at 2048 px, shrinking further above 6MB.
- The client handles AVIF only; a paste carrying non-empty text is left to native handling; a failed
  conversion keeps the original file and logs a warning.
- Tool definitions use standard JSON Schema (`required` is an array of strings), so
  `tools.register` accepts them directly. Added 12 unit tests (10 host, 2 client) covering the
  standard-schema shape, conversion, passthrough, sniffing, error paths, listener installation and
  cleanup.
