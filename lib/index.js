/**
 * dsh-image-formats — host half.
 *
 * The official read_image tool accepts PNG/JPEG/WebP/GIF only. This plugin
 * registers a same-name tool in each agent scope, which shadows the global
 * definition, and converts AVIF/TIFF/SVG to PNG with Sharp/libvips: the copy
 * bundled with DSH desktop, or one installed in a DSH profile when running the
 * CLI. No new runtime dependency and no app.asar edit are required.
 *
 * @module dsh-image-formats
 */

import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'

export const name = 'image-formats'
export const inject = ['fs', 'attachments', 'workingDirectory', 'llm', 'agents']

const requireFromPlugin = createRequire(import.meta.url)

/** Formats stored as-is by the attachment service. */
const DIRECT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Formats this plugin converts to PNG before handing them to the store. */
const CONVERTIBLE = {
  '.avif': 'avif',
  '.tif': 'tiff',
  '.tiff': 'tiff',
  '.svg': 'svg',
}

/** Formats Sharp cannot decode in the stock DSH build; name the limitation instead of guessing. */
const KNOWN_UNSUPPORTED = {
  '.heic': 'HEIC/HEIF (HEVC)',
  '.heif': 'HEIC/HEIF (HEVC)',
  '.jxl': 'JPEG XL',
  '.psd': 'PSD',
  '.raw': 'camera RAW',
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MAX_INPUT_PIXELS = 268435456

class ImageInputError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ImageInputError'
    this.code = code
  }
}

/**
 * Two host lines spell the same rejection: 0.2.2-rc.5 throws
 * `IMAGE_UNSUPPORTED_MODEL` (dsh-tool-fs/src/read-image.ts:136) and
 * 0.2.3-alpha.1 renamed it to `MODEL_DOES_NOT_SUPPORT_IMAGES` (same file,
 * :137). Recognition widens to both spellings; this plugin keeps reporting the
 * rc.5 spelling so existing consumers, docs and tests stay valid.
 */
export const IMAGE_MODEL_UNSUPPORTED_CODES = Object.freeze([
  'IMAGE_UNSUPPORTED_MODEL',
  'MODEL_DOES_NOT_SUPPORT_IMAGES',
])

/** True when `code` is either host spelling of "this model cannot take images". */
export function isImageModelUnsupportedCode(code) {
  return typeof code === 'string' && IMAGE_MODEL_UNSUPPORTED_CODES.includes(code)
}

function matchesBytes(data, offset, expected) {
  if (data.byteLength < offset + expected.length) return false
  return expected.every((byte, index) => data[offset + index] === byte)
}

function matchesAscii(data, offset, value) {
  if (data.byteLength < offset + value.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (data[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

function asciiAt(data, offset, length) {
  let out = ''
  for (let index = 0; index < length && offset + index < data.byteLength; index += 1) {
    out += String.fromCharCode(data[offset + index])
  }
  return out
}

/** Identify direct attachment formats by signature. */
function sniffDirectType(data) {
  if (matchesBytes(data, 0, PNG_SIGNATURE)) return 'image/png'
  if (matchesBytes(data, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (matchesAscii(data, 0, 'GIF87a') || matchesAscii(data, 0, 'GIF89a')) return 'image/gif'
  if (matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'WEBP')) return 'image/webp'
  return undefined
}

function looksLikeAvif(data) {
  return matchesAscii(data, 4, 'ftyp') && asciiAt(data, 8, 32).includes('avif')
}

function looksLikeHeic(data) {
  if (!matchesAscii(data, 4, 'ftyp')) return false
  const brand = asciiAt(data, 8, 4)
  return brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx' || (brand === 'mif1' && asciiAt(data, 8, 32).includes('heic'))
}

function looksLikeTiff(data) {
  return matchesBytes(data, 0, [0x49, 0x49, 0x2a, 0x00]) || matchesBytes(data, 0, [0x4d, 0x4d, 0x00, 0x2a])
}

function looksLikeSvg(data) {
  let text = ''
  const limit = Math.min(data.byteLength, 4096)
  for (let index = 0; index < limit; index += 1) text += String.fromCharCode(data[index])
  const trimmed = text.replace(/^\u00EF\u00BB\u00BF/, '').replace(/^\uFEFF/, '').trimStart()
  return trimmed.startsWith('<svg') || (trimmed.startsWith('<?xml') && trimmed.includes('<svg'))
}

/** Classify an extension-less image by signature, throwing for known-but-undecodable containers. */
function sniffConvertible(data) {
  if (looksLikeAvif(data)) return 'avif'
  if (looksLikeTiff(data)) return 'tiff'
  if (looksLikeSvg(data)) return 'svg'
  if (looksLikeHeic(data)) {
    throw new ImageInputError('cannot read this image: HEIC/HEIF needs an HEVC decoder that the bundled Sharp/libvips does not include; convert it to AVIF, PNG, JPEG, or WebP first', 'IMAGE_UNSUPPORTED_FORMAT')
  }
  return undefined
}

function loadFirst(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    try {
      return requireFromPlugin(candidate)
    } catch {
      // Try the next installation layout.
    }
  }
  return undefined
}

function activeProfileNames() {
  const names = []
  const add = (value) => {
    if (typeof value === 'string' && value.length > 0 && value !== 'true' && !names.includes(value)) names.push(value)
  }
  add(process.env.DSH_PROFILE)
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index]
    if (arg === '--profile') add(process.argv[index + 1])
    else if (typeof arg === 'string' && arg.startsWith('--profile=')) add(arg.slice('--profile='.length))
  }
  return names
}

function profileSharpCandidates() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  if (home.length === 0) return []
  const names = activeProfileNames()
  try {
    for (const entry of readdirSync(join(home, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory() && !names.includes(entry.name)) names.push(entry.name)
    }
  } catch {
    // A home without profiles is fine; the fixed candidates still apply.
  }
  return names.map(profile => join(home, 'profiles', profile, 'node_modules', 'sharp'))
}

/**
 * Resolve a Sharp module. The desktop app ships one inside app.asar; the CLI
 * does not, so a Sharp installed in any DSH profile is the next best source.
 * Exported so tests and diagnostics can inspect the same candidate order.
 */
export function loadSharpFromInstallation() {
  const candidates = []
  if (process.env.DSH_IMAGE_FORMATS_SHARP) candidates.push(process.env.DSH_IMAGE_FORMATS_SHARP)
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', 'sharp'))
    candidates.push(join(process.resourcesPath, 'app.asar', 'node_modules', 'sharp'))
  }
  if (process.execPath) {
    const dir = dirname(process.execPath)
    candidates.push(join(dir, 'resources', 'app.asar', 'dsh', 'node_modules', 'sharp'))
    candidates.push(join(dir, 'resources', 'app.asar', 'node_modules', 'sharp'))
    candidates.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'sharp'))
  }
  candidates.push(...profileSharpCandidates())
  candidates.push('sharp')
  const loaded = loadFirst(candidates)
  return loaded?.default ?? loaded
}

async function assertImageCapableRoute(ctx, exec, requestedPath) {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new ImageInputError('cannot read "' + requestedPath + '" as an image: the current model route could not be resolved', 'IMAGE_UNSUPPORTED_MODEL')
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new ImageInputError('cannot read "' + requestedPath + '" as an image: model "' + model + '" does not declare image input; switch to an image-capable model to read images', 'IMAGE_UNSUPPORTED_MODEL')
  }
}

function assertDeploymentAccepts(attachments, mediaType, displayPath) {
  if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
    throw new ImageInputError('cannot read "' + displayPath + '": ' + mediaType + ' images are not accepted by this deployment', 'IMAGE_UNSUPPORTED_FORMAT')
  }
}

async function resolveTarget(ctx, exec, requestedPath) {
  const fs = ctx.get('fs')
  const workingDirectory = ctx.get('workingDirectory')
  if (fs === undefined || workingDirectory === undefined) {
    throw new ImageInputError('cannot read "' + requestedPath + '" as an image: the filesystem or working-directory service is not mounted', 'TOOL_CONTEXT_UNAVAILABLE')
  }
  const cwd = exec.agent === undefined ? undefined : await workingDirectory.ensure(exec.agent, exec.signal)
  const target = await fs.resolve(requestedPath, { cwd, signal: exec.signal })
  const info = await fs.stat(target, exec.signal)
  if (info === undefined) throw new ImageInputError('cannot read "' + requestedPath + '": the path does not exist', 'FS_NOT_FOUND')
  if (info.type !== 'file') throw new ImageInputError('cannot read "' + requestedPath + '": the path is not a regular file', 'FS_NOT_REGULAR_FILE')
  return { target, info }
}

function convertedName(displayPath) {
  const original = basename(displayPath)
  const extension = extname(original)
  return (extension.length === 0 ? original : original.slice(0, -extension.length)) + '.png'
}

async function convertToPng(sharp, data, kind) {
  const options = {
    failOn: 'none',
    limitInputPixels: MAX_INPUT_PIXELS,
    animated: false,
  }
  if (kind === 'svg') options.density = 144
  const image = sharp(Buffer.from(data), options)
  if (kind !== 'svg') image.rotate()
  return image.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
}

function imageRefFromValue(image) {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
    ...image.originalDimensions === undefined ? {} : { originalDimensions: { ...image.originalDimensions } },
  }
}

function formatImageReadOutput(displayPath, image) {
  let scaled = ''
  if (image.originalDimensions !== undefined) {
    const x = (image.originalDimensions.width / image.width).toFixed(2)
    const y = (image.originalDimensions.height / image.height).toFixed(2)
    const advice = x === y
      ? 'multiply coordinates by ' + x
      : 'multiply x coordinates by ' + x + ' and y coordinates by ' + y
    scaled = ' (downscaled from ' + image.originalDimensions.width + 'x' + image.originalDimensions.height + ' px; ' + advice + ' to locate features in the original file)'
  }
  return '<path>' + displayPath + '</path>\n<type>image</type>\n<content>\n' + image.mediaType + ' image, ' + image.width + 'x' + image.height + ' px, ' + image.bytes + ' bytes' + scaled + '\n</content>'
}

function imageReadContent(value) {
  return [
    { type: 'text', text: formatImageReadOutput(value.path, value.image) },
    { type: 'image', attachment: imageRefFromValue(value.image) },
  ]
}

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height'],
      properties: {
        width: { type: 'integer' },
        height: { type: 'integer' },
      },
    },
  },
}

function saveFailure(error, displayPath) {
  const message = error instanceof Error ? error.message : String(error)
  const reported = typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : 'IMAGE_SAVE_FAILED'
  // Recognize either host spelling of the model-capability failure, but report
  // the stable rc.5-compatible code this plugin documents. Every other code --
  // notably alpha's IMAGE_REQUEST_TOO_LARGE -- still passes through untouched.
  const code = isImageModelUnsupportedCode(reported) ? 'IMAGE_UNSUPPORTED_MODEL' : reported
  return new ImageInputError('cannot read "' + displayPath + '": ' + message, code)
}

/**
 * Build the agent-scoped read_image definition. Services are resolved from the
 * root plugin context at execution time so a later service replacement still
 * reaches the tool.
 */
function createReadImageTool(ctx, loadSharp) {
  return {
    name: 'read_image',
    description: 'Read a PNG/JPEG/WebP/GIF/AVIF/TIFF/SVG file and return the image itself. '
      + 'AVIF, TIFF, and SVG are converted to PNG automatically; large images are downscaled automatically. '
      + 'Do not install image libraries or create thumbnails to inspect an image.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['file_path'],
      properties: {
        file_path: { type: 'string', description: 'Path to the image file, resolved by the filesystem backend.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'image'],
        properties: {
          path: { type: 'string', description: 'Canonical absolute path in the filesystem execution world.' },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => imageReadContent(value),
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (typeof args.file_path !== 'string' || args.file_path.trim().length === 0) {
        throw new ImageInputError('file_path must be a non-empty string', 'INVALID_ARGUMENT')
      }

      const extension = extname(args.file_path).toLowerCase()
      let direct = DIRECT_TYPES[extension]
      let kind = CONVERTIBLE[extension]
      if (direct === undefined && kind === undefined && extension !== '') {
        const label = KNOWN_UNSUPPORTED[extension]
        if (label !== undefined) {
          throw new ImageInputError('cannot read "' + args.file_path + '": ' + label + ' is not supported by the bundled Sharp/libvips; convert it to AVIF, PNG, JPEG, or WebP first', 'IMAGE_UNSUPPORTED_FORMAT')
        }
        throw new ImageInputError('cannot read "' + args.file_path + '": the ' + extension + ' extension does not declare a supported image format; read_image accepts PNG/JPEG/WebP/GIF/AVIF/TIFF/SVG files, including extension-less files in those formats', 'IMAGE_UNSUPPORTED_FORMAT')
      }

      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new ImageInputError('cannot read "' + args.file_path + '" as an image: no attachment service is mounted', 'TOOL_CONTEXT_UNAVAILABLE')
      }
      if (direct !== undefined) assertDeploymentAccepts(attachments, direct, args.file_path)
      // Known convertible formats always end up as image/png: reject a deployment
      // that cannot store PNG before reading or decoding the source file.
      else if (kind !== undefined) assertDeploymentAccepts(attachments, 'image/png', args.file_path)
      await assertImageCapableRoute(ctx, exec, args.file_path)

      const { target, info } = await resolveTarget(ctx, exec, args.file_path)
      const fs = ctx.get('fs')
      const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      const data = await fs.readBytes(target, exec.signal, byteCap)

      if (direct === undefined && kind === undefined) {
        direct = sniffDirectType(data)
        if (direct === undefined) kind = sniffConvertible(data)
        if (direct === undefined && kind === undefined) {
          throw new ImageInputError('cannot read "' + target.displayPath + '": the file content is not a supported image format; read_image accepts PNG/JPEG/WebP/GIF/AVIF/TIFF/SVG', 'IMAGE_UNSUPPORTED_FORMAT')
        }
        if (direct !== undefined) assertDeploymentAccepts(attachments, direct, target.displayPath)
        // Extension-less convertible files are classified only after reading bytes;
        // still reject an unsupported PNG output before decoding them.
        else if (kind !== undefined) assertDeploymentAccepts(attachments, 'image/png', target.displayPath)
      }

      let output = data
      let mediaType = direct
      let name = basename(target.displayPath)
      if (kind !== undefined) {
        const sharp = loadSharp()
        if (sharp === undefined) {
          throw new ImageInputError('cannot read "' + target.displayPath + '": AVIF/TIFF/SVG conversion needs Sharp/libvips (bundled with DSH desktop, or installed in a DSH profile), but it could not be loaded; install Sharp or convert the file to PNG/JPEG/WebP/GIF first', 'IMAGE_CONVERTER_UNAVAILABLE')
        }
        try {
          output = await convertToPng(sharp, data, kind)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new ImageInputError('cannot read "' + target.displayPath + '" as ' + kind.toUpperCase() + ': conversion to PNG failed: ' + message, 'IMAGE_CONVERT_FAILED')
        }
        mediaType = 'image/png'
        name = convertedName(target.displayPath)
        assertDeploymentAccepts(attachments, mediaType, target.displayPath)
      }

      if (exec.signal !== undefined && exec.signal.aborted) {
        if (typeof exec.signal.throwIfAborted === 'function') exec.signal.throwIfAborted()
        throw new ImageInputError('cannot read "' + target.displayPath + '": the request was cancelled during image conversion', 'IMAGE_CONVERSION_CANCELLED')
      }

      let ref
      try {
        ref = await attachments.saveImage({ data: output, mediaType, name })
      } catch (error) {
        throw saveFailure(error, target.displayPath)
      }
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return {
        path: fs.processPath(target),
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...ref.name === undefined ? {} : { name: ref.name },
          ...ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } },
        },
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: 'Read image ' + args.file_path,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  }
}

/**
 * Register the shadow tool for every live agent and every agent created later.
 * @param ctx - plugin context.
 * @param options - test seam; production callers omit it.
 */
export function apply(ctx, options = {}) {
  const loadSharp = options.loadSharp ?? loadSharpFromInstallation
  const seen = new WeakSet()
  const disposers = new Set()
  const register = (agent) => {
    if (agent === undefined || agent === null || seen.has(agent)) return
    const tools = agent.ctx?.tools
    if (tools === undefined || typeof tools.register !== 'function') return
    seen.add(agent)
    const dispose = tools.register(createReadImageTool(ctx, loadSharp))
    if (typeof dispose === 'function') disposers.add(dispose)
  }
  ctx.on('agent/created', (event) => register(event?.agent))
  const agents = ctx.get?.('agents') ?? ctx.agents
  for (const agent of agents?.list?.() ?? []) register(agent)
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) dispose()
      disposers.clear()
    }, 'image-formats: agent read_image')
  }
}
