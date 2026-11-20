# Changelog

## [0.1.0] - 2026-11-20

首个版本 / First release.

- 宿主侧新增同名 `read_image`，通过 agent 作用域遮蔽官方工具，把 AVIF/TIFF/SVG 转成 PNG 后交给
  现有附件服务；PNG/JPEG/WebP/GIF 原样直通，无扩展名文件按字节嗅探。
- 复用 DSH 桌面版自带的 Sharp/libvips；CLI 没有内置 Sharp 时，按当前 profile、其他 profile
  的顺序查找已安装的 Sharp。不修改 `app.asar`，不新增运行时依赖；Sharp 缺失或转换失败时
  返回可诊断的错误码。
- 对 AVIF/TIFF/SVG 先检查最终输出 `image/png` 是否在部署的附件白名单内，再读取和解码源文件，
  避免注定失败的请求消耗文件读取与转换。
- HEIC/HEIF 明确报错：自带 libvips 没有 HEVC 解码器，插件建议先转 AVIF/PNG/JPEG/WebP；
  JXL/PSD/相机 RAW 同样不在支持范围。
- 客户端在捕获阶段拦截粘贴、拖拽和文件选择中的 AVIF，用浏览器解码后编码为 PNG，再写回
  composer 隐藏的 file input，让官方 `intakeFiles` 走原上传链路；长边限制 2048，超过 6MB 继续缩小。
- 客户端只处理 AVIF；粘贴同时带非空文字时让给原生逻辑；转换失败保留原文件并输出警告。
- 客户端回灌隐藏 input 时用 WeakSet 标记自己派发的 change，避免转换失败后再次拦截形成
  无限重试；原文件只交给官方上传链路一次。
- 工具定义使用标准 JSON Schema（`required` 为字符串数组），可直接通过 agent 作用域的
  `tools.register` 校验；新增 14 条单元测试（宿主 11 条、客户端 3 条），覆盖标准 schema 形状、
  转换、直通、嗅探、白名单前置检查、回灌防重入、错误路径、监听安装与清理。

- Added a same-name host `read_image` that shadows the official tool in each agent scope and converts
  AVIF/TIFF/SVG to PNG before the existing attachment service sees them. PNG/JPEG/WebP/GIF pass
  through untouched; extension-less files are identified by signature.
- Reuses the Sharp/libvips bundled with the DSH installation. No `app.asar` edit and no new runtime
  dependency; missing Sharp or a failed conversion produces a diagnosable error code.
- AVIF/TIFF/SVG now check the final `image/png` type against the deployment's attachment allowlist
  before reading or decoding the source, so a request that cannot succeed never touches the file.
- HEIC/HEIF is refused explicitly: the bundled libvips has no HEVC decoder, so the plugin suggests
  converting to AVIF/PNG/JPEG/WebP first. JXL, PSD and camera RAW are likewise out of scope.
- The client intercepts AVIF on paste, drop and file picking at capture phase, decodes it in the
  browser, encodes PNG, and writes it back into the composer's hidden file input so the official
  `intakeFiles` upload path still runs. Long edge is capped at 2048 px, shrinking further above 6MB.
- The client handles AVIF only; a paste carrying non-empty text is left to native handling; a failed
  conversion keeps the original file and logs a warning.
- A WeakSet marks the change events the client dispatches back into the hidden input, so a failed
  conversion cannot be intercepted again in an infinite retry; the original file reaches the
  official upload path exactly once.
- Added 14 unit tests (11 host, 3 client) covering conversion, passthrough, sniffing, allowlist
  prechecks, re-entry protection, error paths, listener installation and cleanup.
