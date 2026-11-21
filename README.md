# dsh-image-formats

[![CI](https://github.com/TLEWA/dsh-image-formats/actions/workflows/ci.yml/badge.svg)](https://github.com/TLEWA/dsh-image-formats/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-image-formats.svg)](https://www.npmjs.com/package/dsh-image-formats)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[简体中文](README.md) · [English](README.en.md)

让 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的 `read_image` 和输入框直接接受
**AVIF / TIFF / SVG**：需要时自动转成 PNG，再交给现有的附件与上传链路。

DSH 原生只认 PNG、JPEG、WebP、GIF。AVIF 在客户端上传前就会被拒，`read_image` 也会按扩展名
拒绝 AVIF/TIFF/SVG。本插件不改 `app.asar`，也不新增运行时依赖：宿主侧优先复用 DSH 桌面版
自带的 Sharp/libvips，CLI profile 里没有时回退到某个 profile 已安装的 Sharp；客户端侧复用
浏览器自带的解码器和 canvas。

## 它解决什么

| 入口 | 原生 DSH | 装了本插件 |
| --- | --- | --- |
| 输入框粘贴 / 拖拽 / 选择 AVIF | 上传前拒绝 | 浏览器转成 PNG，再走官方上传链路 |
| `read_image` 读 AVIF | 扩展名或字节嗅探拒绝 | Sharp 转成 PNG 后作为图片附件返回 |
| `read_image` 读 TIFF | 拒绝 | Sharp 转成 PNG |
| `read_image` 读 SVG | 拒绝 | Sharp/libvips 渲染成 PNG |
| PNG / JPEG / WebP / GIF | 正常 | 原样直通，不经过转换器 |
| HEIC / HEIF / JXL / PSD / RAW | 拒绝 | 明确报错并给出可操作的建议，不静默猜测 |

## 两半实现

### 宿主：同名 `read_image` 遮蔽全局工具

插件在 `agent/created` 时为每个 agent 注册一个同名 `read_image`，并通过
`agent.ctx.tools.register` 让它只作用于该 agent；agent 作用域的工具会遮蔽全局定义，所以模型
看到的仍是熟悉的一个 `read_image`，但实现换成了本插件。插件加载时已经存在的 agent 也会补注册。

执行顺序与官方工具保持一致：

1. 校验 `file_path`，按扩展名分类；
2. 检查部署的附件白名单和调用路由是否声明 `image` 输入；
3. 通过 `ctx.fs` 解析并读取文件，字节上限取 `maxImageBytes` 与 `maxMessageImageBytes` 的较小值；
4. 直接格式（PNG/JPEG/WebP/GIF）原样保存；AVIF/TIFF/SVG 先用 Sharp 转 PNG；
5. 调 `attachments.saveImage`，返回与官方一致的 `{ path, image }`，并发出 `fs/observed`。

转换使用 DSH 安装包或 profile 内的 Sharp：

- 输入限制 `limitInputPixels: 268435456`，`failOn: 'none'`，只取第一帧；
- SVG 用 `density: 144` 渲染；其他格式按 EXIF 方向自动旋转；
- 输出 PNG 用 `compressionLevel: 9`，文件名从 `photo.avif` 变成 `photo.png`；
- 找不到 Sharp 时抛出可诊断的 `IMAGE_CONVERTER_UNAVAILABLE`，不会退回“猜一个格式”。

Sharp 候选路径按顺序尝试：`DSH_IMAGE_FORMATS_SHARP` 环境变量、`process.resourcesPath` 下的
`app.asar/dsh/node_modules/sharp` 与 `app.asar/node_modules/sharp`、可执行文件同级的
`resources/...`、`<DSH_HOME>/profiles/<profile>/node_modules/sharp`（先当前 profile，再其他
profile；`DSH_HOME` 未设置时用 `~/.dsh`），最后才是普通 `sharp`。DSH 桌面版自带的那份通常
能在前几个候选里命中；CLI 没有内置 Sharp，需要某个 profile 里装过 Sharp。

### 客户端：在文件进入 composer 前换掉

客户端插件在 document 的捕获阶段监听 `paste`、`drop` 和 `change`：

1. 只挑出 AVIF（MIME 为 `image/avif`，或扩展名是 `.avif` 且没有声明其他类型）；
2. 用 `createImageBitmap` 解码，失败时回退到 `<img>` + object URL；
3. 画到 canvas，长边限制 2048，用 `canvas.toBlob('image/png')` 编码；超过 6MB 时逐级缩到
   1024 再试；
4. 把 PNG 交给宿主公开槽位 `conversation.input.attachments` 的 `onAddFiles`（owner props），
   由官方 `intakeFiles` 走原上传链路；只有宿主没有这个槽位时才回退到旧的 DOM 路径——用
   `DataTransfer` 写回 composer 里隐藏的 `input[type=file][hidden]`，再派发冒泡的 `change` 事件。

该槽位是单槽：注册进去会遮住宿主自带的附件栏，而那个附件栏没有公开的重建入口。所以桥接组件只在
槽位为空时挂载，一旦出现其他注册者（正常安装的 rc.5 就有宿主自己那一个）立刻撤销，继续走 DOM
回灌，宿主界面完全不变。槽位服务晚于插件就绪时，插件会等 `internal/service` 再补挂一次。

这样官方 InputBar 的 `onPickFiles` / `intakeFiles` 会按原路径处理 PNG，插件不需要调用任何
私有上传函数。转换在内存里完成，不落临时文件，不发网络请求。

粘贴时如果剪贴板同时带非空 `text/plain`，插件会让给原生逻辑，避免吞掉文字。

## 安装

要求：

- DSH `0.2.1-rc.5` 或更新版本，且低于 `0.3.0`；
- Node.js `20` 或更新版本（插件本身不新增依赖；DSH CLI 需要某个 profile 或环境中提供
  Sharp，桌面版自带）。

### 从 npm 安装（发布后）

侧边栏 **插件** → **安装插件**，输入：

```text
dsh-image-formats
```

或：

```powershell
dsh plugin --profile desktop add dsh-image-formats
```

### 从 GitHub 安装

```text
https://github.com/TLEWA/dsh-image-formats
```

固定到标签：

```powershell
dsh plugin --profile desktop add github:TLEWA/dsh-image-formats#v0.1.0
```

### 从源码安装

```powershell
git clone https://github.com/TLEWA/dsh-image-formats.git
cd dsh-image-formats
npm test
dsh plugin --profile desktop add .
```

安装后重启 DSH：宿主插件在 profile 启动时加载，客户端插件在 Web UI 刷新后生效。

## 兼容与限制

- **HEIC/HEIF 不做**：DSH 桌面版自带的 Sharp/libvips 没有 HEVC 解码器（需要 libde265），所以即使
  转成 HEIC 也读不了。插件会明确报 `HEIC/HEIF (HEVC)`，并建议先转 AVIF/PNG/JPEG/WebP；
- **JPEG XL、PSD、相机 RAW 不做**：Sharp 没有这些解码器；
- 客户端只自动转换 **AVIF**。浏览器没有稳定的 TIFF 解码器，SVG 走 canvas 又涉及跨域/安全边界，
  所以拖拽 TIFF/SVG 仍会被官方上传链路拒绝；用 `read_image` 读路径不受影响；
- 客户端优先用宿主公开槽位 `conversation.input.attachments`；该槽位被占用时（DSH 默认安装
  就是如此）回退到 composer 的隐藏文件输入和 `data-composer-card` 标记。DSH 改版后如果这两处
  结构变了，需要跟着更新；
- 转换只保留第一帧：AVIF/TIFF 的动画或多页内容不会带过去；
- 转换会重新编码：EXIF、ICC/HDR、10-bit 等信息可能丢失或变化，PNG 体积也可能比原 AVIF 大；
- 原文件不会被修改；会话里新增的是 PNG 附件；
- 宿主的图片能力门槛与官方一致：调用路由必须声明 `image` 输入，否则会先报
  `IMAGE_UNSUPPORTED_MODEL`，不会白读文件。0.2.3-alpha.1 把同一语义的错误码改名为
  `MODEL_DOES_NOT_SUPPORT_IMAGES`；插件通过 `IMAGE_MODEL_UNSUPPORTED_CODES` 与
  `isImageModelUnsupportedCode()` 同时识别两种拼写，对外仍统一报告 `IMAGE_UNSUPPORTED_MODEL`，
  其它错误码原样透传；
- 首次转换会在内存里读入整张图，超大图受 DSH 附件字节上限约束。

## 开发与测试

```powershell
npm run check   # node --check lib/index.js && node --check lib/client.js
npm test        # node --test test/host.test.js test/client.test.js
```

测试覆盖：

- `test/host.test.js`：注册与去重、标准 JSON Schema 形状、AVIF/TIFF/SVG 转 PNG、直接格式
  直通、无扩展名 AVIF 嗅探、HEIC 拒绝、未知扩展名/空参数、非视觉模型、新旧模型错误码识别与其它
  错误码透传、Sharp 缺失与转换失败；
- `test/client.test.js`：用 `node:vm` 加载客户端包，验证 ModuleLoader id、`inject`、`apply`
  安装的三个捕获监听，以及 `ctx.effect` 的清理。

真机回归：在 DSH Web UI 里分别用粘贴、拖拽、文件选择上传 AVIF，确认 composer 收到 PNG；
再让模型对一张 AVIF/TIFF/SVG 路径调用 `read_image`，确认附件媒体类型是 `image/png`。

## 我的其他 DSH 项目

- **[dsh-sidebar-row-menu](https://github.com/TLEWA/dsh-sidebar-row-menu)** —— 侧栏工作区行与会话行的右键菜单。
- **[dsh-sidebar-organizer](https://github.com/TLEWA/dsh-sidebar-organizer)** —— 七区域布局拖拽整理。
- **[dsh-better-choice](https://github.com/TLEWA/dsh-better-choice)** —— `ask_user_question` 的备注与旁问增强。
- **[dsh-if](https://github.com/TLEWA/dsh-if)** —— `/if` 条件指令。
- **[dsh-opencode-go-router](https://github.com/TLEWA/dsh-opencode-go-router)** —— 上下文折叠后的 OpenCode Go 路由轮换。
- **[dsh-fastload](https://github.com/TLEWA/dsh-fastload)** —— 长会话首屏历史瘦身。
- **[dsh-ptc-noargs](https://github.com/TLEWA/dsh-ptc-noargs)** —— PTC `run_code` 无参工具调用归一化。
- **[dsh-ps51-guard](https://github.com/TLEWA/dsh-ps51-guard)** —— PowerShell 5.1 调用护栏。
- **[dsh-utf8-output](https://github.com/TLEWA/dsh-utf8-output)** —— 修复 Windows 子进程 GBK/CP936 乱码。

## 许可证

MIT © 2026 TLEWA

## Codex PR 审阅

本仓采用[中心 CI](https://github.com/TLEWA/dsh-plugin-ci)的 v1 公共审阅规则，实际规则保存在 AGENTS.md。
云端 Codex 审阅 PR 及新提交，维护者最终批准并合并；审阅结论必须对应最新提交。审阅消耗订阅用量，
漏触发时可用 `@codex review` 补审。
