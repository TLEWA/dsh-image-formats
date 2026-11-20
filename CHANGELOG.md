# Changelog

## [0.1.0] - 2026-11-20

首个版本 / First release.

- 宿主侧新增同名 `read_image`，通过 agent 作用域遮蔽官方工具，把 AVIF/TIFF/SVG 转成 PNG 后交给
  现有附件服务；PNG/JPEG/WebP/GIF 原样直通，无扩展名文件按字节嗅探。
- 复用 DSH 安装包自带的 Sharp/libvips，不修改 `app.asar`，不新增运行时依赖；Sharp 缺失或转换
  失败时返回可诊断的错误码。
- HEIC/HEIF 明确报错：自带 libvips 没有 HEVC 解码器，插件建议先转 AVIF/PNG/JPEG/WebP；
  JXL/PSD/相机 RAW 同样不在支持范围。
- 客户端在捕获阶段拦截粘贴、拖拽和文件选择中的 AVIF，用浏览器解码后编码为 PNG，再写回
  composer 隐藏的 file input，让官方 `intakeFiles` 走原上传链路；长边限制 2048，超过 6MB 继续缩小。
- 客户端只处理 AVIF；粘贴同时带非空文字时让给原生逻辑；转换失败保留原文件并输出警告。
- 新增 11 条单元测试（宿主 9 条、客户端 2 条），覆盖转换、直通、嗅探、错误路径、监听安装与清理。

- Added a same-name host `read_image` that shadows the official tool in each agent scope and converts
  AVIF/TIFF/SVG to PNG before the existing attachment service sees them. PNG/JPEG/WebP/GIF pass
  through untouched; extension-less files are identified by signature.
- Reuses the Sharp/libvips bundled with the DSH installation. No `app.asar` edit and no new runtime
  dependency; missing Sharp or a failed conversion produces a diagnosable error code.
- HEIC/HEIF is refused explicitly: the bundled libvips has no HEVC decoder, so the plugin suggests
  converting to AVIF/PNG/JPEG/WebP first. JXL, PSD and camera RAW are likewise out of scope.
- The client intercepts AVIF on paste, drop and file picking at capture phase, decodes it in the
  browser, encodes PNG, and writes it back into the composer's hidden file input so the official
  `intakeFiles` upload path still runs. Long edge is capped at 2048 px, shrinking further above 6MB.
- The client handles AVIF only; a paste carrying non-empty text is left to native handling; a failed
  conversion keeps the original file and logs a warning.
- Added 11 unit tests (9 host, 2 client) covering conversion, passthrough, sniffing, error paths,
  listener installation and cleanup.
