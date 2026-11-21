# Changelog

## [Unreleased]

- 客户端附件入口改用宿主公开槽位 `conversation.input.attachments`：从 owner props 取 `onAddFiles`，
  转换后的 PNG 直接交给官方上传链路，不再依赖 `[data-composer-card="true"]` 加隐藏
  `input[type="file"]` 这层宿主私有 DOM 实现。
- 该槽位是单槽，注册即遮蔽宿主自带附件栏且没有公开的重建入口，因此桥接组件只在槽位为空时挂载，
  一旦出现其他注册者立即撤销；这种情况下继续走 DOM 回灌，宿主附件栏保持原样。
- 槽位注册与撤销全部幂等：`dispose` 清空回调、退订槽位、注销条目；槽位缺失或抛错只
  `console.warn`，不打断宿主输入框。
- 槽位服务晚于插件就绪时，插件监听 cordis 的 `internal/service` 事件补挂一次桥接，仍然只
  认空槽；一直等不到就永久走 DOM 回灌。客户端没有模块依赖，按要求不声明 `dsh.client.inject`：
  `slots` 通过 `ctx` 获取，不 import 宿主包。
- `read_image` 宿主侧行为与 Sharp 探测逻辑未改动。

## [0.1.0] - 2026-11-20

首个版本 / First release.

- 宿主侧新增同名 `read_image`，通过 agent 作用域遮蔽官方工具，把 AVIF/TIFF/SVG 转成 PNG 后交给
  现有附件服务；PNG/JPEG/WebP/GIF 原样直通，无扩展名文件按字节嗅探。
- 复用 DSH 桌面版自带的 Sharp/libvips；CLI 没有内置 Sharp 时，按当前 profile、其他 profile
  的顺序查找已安装的 Sharp。不修改 `app.asar`，不新增运行时依赖；Sharp 缺失或转换失败时
  返回可诊断的错误码。
- 对已由扩展名确定为 AVIF/TIFF/SVG 的文件，先检查最终输出 `image/png` 是否在部署的附件白名单内，
  再读取和解码源文件；无扩展名文件先按字节嗅探，避免把合法的 JPEG 等直通格式误拒。
- 转换完成后、保存附件前检查 `exec.signal`；用户在 Sharp 转换期间取消调用时不再持久化附件，
  也不发出 `fs/observed`。
- HEIC/HEIF 明确报错：自带 libvips 没有 HEVC 解码器，插件建议先转 AVIF/PNG/JPEG/WebP；
  JXL/PSD/相机 RAW 同样不在支持范围。
- 客户端在捕获阶段拦截粘贴、拖拽和文件选择中的 AVIF，用浏览器解码后编码为 PNG，再写回
  composer 隐藏的 file input，让官方 `intakeFiles` 走原上传链路；长边限制 2048，超过 6MB 继续缩小。
- 客户端只处理 AVIF；粘贴同时带非空文字时让给原生逻辑；转换失败保留原文件并输出警告。
- 客户端判断 AVIF 时优先使用文件声明的 MIME；只有 MIME 为空才回退到 `.avif` 扩展名，避免把声明为
  PNG/JPEG 的文件误转码。
- 客户端回灌隐藏 input 时用 WeakSet 标记自己派发的 change，避免转换失败后再次拦截形成
  无限重试；原文件只交给官方上传链路一次。
- 客户端只拦截位于 composer 卡片内的粘贴、拖放和文件选择，不再回退到最后一个可见 composer，
  避免抢走页面其他区域的文件操作。
- 每次安装持有令牌，插件卸载后仍在解码/编码的旧任务不会回灌 composer。
- 每次安装的清理函数幂等；重复 `apply` 时旧上下文不会误删新安装的监听器。
- 工具定义使用标准 JSON Schema（`required` 为字符串数组），可直接通过 agent 作用域的
  `tools.register` 校验；新增 21 条单元测试（宿主 14 条、客户端 7 条），覆盖标准 schema 形状、
  转换、直通、嗅探、MIME 优先级、白名单前置检查、composer 归属、卸载后失效、取消、幂等清理、
  回灌防重入、错误路径、监听安装与清理。

- Added a same-name host `read_image` that shadows the official tool in each agent scope and converts
  AVIF/TIFF/SVG to PNG before the existing attachment service sees them. PNG/JPEG/WebP/GIF pass
  through untouched; extension-less files are identified by signature.
- Reuses the Sharp/libvips bundled with the DSH installation. No `app.asar` edit and no new runtime
  dependency; missing Sharp or a failed conversion produces a diagnosable error code.
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
- Added 21 unit tests (14 host, 7 client) covering conversion, passthrough, sniffing, MIME
  precedence, allowlist prechecks, composer scoping, disposal, cancellation, idempotent cleanup,
  re-entry protection, error paths, listener installation and cleanup.
