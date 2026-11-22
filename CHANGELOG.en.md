# Changelog

## [Unreleased]

- Backward-compatible error-code recognition: host 0.2.3-alpha.1 renamed "the model cannot take
  images" from `IMAGE_UNSUPPORTED_MODEL` (rc.5 `dsh-tool-fs/src/read-image.ts:136`) to
  `MODEL_DOES_NOT_SUPPORT_IMAGES` (alpha, same file `:137`). New exports
  `IMAGE_MODEL_UNSUPPORTED_CODES` and `isImageModelUnsupportedCode()` recognize both spellings; a
  failing `saveImage` still reports the stable `IMAGE_UNSUPPORTED_MODEL`, and every other code
  (including alpha's `IMAGE_REQUEST_TOO_LARGE`) keeps passing through untouched. The plugin's own
  codes and rc.5 behaviour are unchanged.
- Tests: two new `test/host.test.js` cases cover "both spellings are recognized" and "other codes
  are unaffected".

## [0.1.0] - 2026-11-20

First release.

- Added a same-name host `read_image` that shadows the official tool in each agent scope and converts
  AVIF/TIFF/SVG to PNG before the existing attachment service sees them. PNG/JPEG/WebP/GIF pass
  through untouched; extension-less files are identified by signature.
- Reuses the Sharp/libvips bundled with DSH desktop; the CLI has no bundled Sharp, so an installed
  copy is discovered in the active profile first and then other profiles. No `app.asar` edit and no
  new runtime dependency; missing Sharp or a failed conversion produces a diagnosable error code.
- Files whose extension already identifies them as AVIF/TIFF/SVG check the final `image/png` type
  against the deployment's attachment allowlist before reading or decoding the source. Extension-less
  files are sniffed first, so a legitimate JPEG passthrough is never rejected by that precheck.
- After conversion, before saving the attachment, `exec.signal` is checked; cancelling a call while
  Sharp is converting no longer persists an attachment or emits `fs/observed`.
- HEIC/HEIF is refused explicitly: the bundled libvips has no HEVC decoder, so the plugin suggests
  converting to AVIF/PNG/JPEG/WebP first. JXL, PSD and camera RAW are likewise out of scope.
- The client intercepts AVIF on paste, drop and file picking at capture phase, decodes it in the
  browser, encodes PNG, and writes it back into the composer's hidden file input so the official
  `intakeFiles` upload path still runs. Long edge is capped at 2048 px, shrinking further above 6MB.
- The client handles AVIF only; a paste carrying non-empty text is left to native handling; a failed
  conversion keeps the original file and logs a warning.
- The client trusts a non-empty declared MIME; the `.avif` extension is only a fallback when the
  browser reports no type, so a PNG/JPEG file with an avif name is not re-encoded.
- A WeakSet marks the change events the client dispatches back into the hidden input, so a failed
  conversion cannot be intercepted again in an infinite retry; the original file reaches the
  official upload path exactly once.
- The client only intercepts paste, drop and file picking inside a composer card. It no longer falls
  back to the last visible composer, so file operations elsewhere on the page are left untouched.
- Each install owns a token; conversions still decoding or encoding after the plugin is disposed
  never feed the composer.
- Each install's cleanup is idempotent: a repeated `apply` cannot let the old context remove the new
  install's listeners.
- Tool definitions use standard JSON Schema (`required` is an array of strings), so
  `tools.register` accepts them directly. Added 21 unit tests (14 host, 7 client) covering the
  standard-schema shape, conversion, passthrough, sniffing, MIME precedence, allowlist prechecks,
  composer scoping, disposal, cancellation, idempotent cleanup, re-entry protection, error paths,
  listener installation and cleanup.
