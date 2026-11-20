import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../lib/index.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
const AVIF = Buffer.from('000000186674797061766966000000006176696600000000', 'hex')

function fakeSharp(output = PNG) {
  const calls = []
  const sharp = (data, options) => {
    calls.push({ data, options })
    return {
      rotate() { return this },
      png(options) { calls.push({ png: options }); return this },
      async toBuffer() { return output },
    }
  }
  sharp.calls = calls
  return sharp
}

function fakeServices(overrides = {}) {
  const saved = []
  const services = {
    attachments: {
      imageLimits: {
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        maxImageBytes: 1024 * 1024,
        maxMessageImageBytes: 2 * 1024 * 1024,
        maxImageDimension: 2048,
        maxImagePixels: 4096 * 4096,
      },
      async saveImage(input) {
        saved.push(input)
        return {
          attachmentId: 'attachment-1',
          mediaType: input.mediaType,
          bytes: input.data.length,
          width: 2,
          height: 2,
          name: input.name,
        }
      },
    },
    workingDirectory: { ensure: async () => 'C:/work' },
    fs: {
      resolve: async (requestedPath) => ({ displayPath: requestedPath, realPath: requestedPath }),
      stat: async () => ({ type: 'file', version: 7 }),
      readBytes: async () => AVIF,
      processPath: (target) => target.displayPath,
    },
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
    agents: { list: () => [] },
    ...overrides,
  }
  return { services, saved }
}

function agentFor() {
  const registered = []
  const agent = {
    session: { requestHeader: () => ({ config: { provider: 'test', model: 'vision' } }) },
    options: { provider: 'test', model: 'vision' },
    ctx: { tools: { register: (definition) => registered.push(definition) } },
  }
  agent.registered = registered
  return { registered, agent }
}

function makeCtx(services) {
  const created = []
  return {
    created,
    ctx: {
      get: (name) => services[name],
      on: (event, listener) => created.push({ event, listener }),
      emit: () => undefined,
      agents: services.agents,
    },
  }
}

const exec = {
  signal: AbortSignal.timeout(10_000),
  agent: {
    session: { requestHeader: () => ({ config: { provider: 'test', model: 'vision' } }) },
    options: { provider: 'test', model: 'vision' },
  },
}

test('registers a shadow read_image for live and future agents', () => {
  const { agent } = agentFor()
  const { services } = fakeServices({ agents: { list: () => [agent] } })
  const { ctx, created } = makeCtx(services)
  apply(ctx, { loadSharp: () => fakeSharp() })
  assert.equal(agent.registered.length, 1)
  assert.equal(agent.registered[0].name, 'read_image')
  assert.equal(created[0].event, 'agent/created')

  const second = agentFor()
  created[0].listener({ agent: second.agent })
  assert.equal(second.agent.registered.length, 1)
  created[0].listener({ agent: second.agent })
  assert.equal(second.agent.registered.length, 1)
})

test('converts AVIF to PNG and keeps the attachment media type direct', async () => {
  const { agent } = agentFor()
  const { services, saved } = fakeServices({ agents: { list: () => [agent] } })
  const { ctx } = makeCtx(services)
  const sharp = fakeSharp(PNG)
  apply(ctx, { loadSharp: () => sharp })
  const tool = agent.registered[0]

  const result = await tool.execute({ file_path: 'picture.avif' }, exec)
  assert.equal(result.path, 'picture.avif')
  assert.equal(result.image.mediaType, 'image/png')
  assert.equal(result.image.name, 'picture.png')
  assert.equal(result.image.bytes, PNG.length)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].mediaType, 'image/png')
  assert.equal(saved[0].name, 'picture.png')
  assert.equal(sharp.calls.length, 2)
  assert.equal(sharp.calls[0].options.failOn, 'none')
})

test('converts TIFF and SVG too', async () => {
  const { agent } = agentFor()
  const { services, saved } = fakeServices({ agents: { list: () => [agent] } })
  const { ctx } = makeCtx(services)
  apply(ctx, { loadSharp: () => fakeSharp(PNG) })
  const tool = agent.registered[0]

  await tool.execute({ file_path: 'scan.tif' }, exec)
  await tool.execute({ file_path: 'diagram.svg' }, exec)
  assert.deepEqual(saved.map((entry) => entry.mediaType), ['image/png', 'image/png'])
  assert.deepEqual(saved.map((entry) => entry.name), ['scan.png', 'diagram.png'])
})

test('passes direct formats through without loading sharp', async () => {
  const { agent } = agentFor()
  const { services, saved } = fakeServices({ agents: { list: () => [agent] } })
  const { ctx } = makeCtx(services)
  let sharpCalls = 0
  apply(ctx, { loadSharp: () => { sharpCalls += 1; return fakeSharp() } })
  const tool = agent.registered[0]

  const result = await tool.execute({ file_path: 'photo.png' }, exec)
  assert.equal(result.image.mediaType, 'image/png')
  assert.equal(sharpCalls, 0)
  assert.equal(saved[0].data.length, AVIF.length)
})

test('sniffs an extension-less AVIF and a misnamed AVIF by bytes', async () => {
  const { agent } = agentFor()
  const { services, saved } = fakeServices({ agents: { list: () => [agent] } })
  const { ctx } = makeCtx(services)
  apply(ctx, { loadSharp: () => fakeSharp(PNG) })
  const tool = agent.registered[0]

  await tool.execute({ file_path: 'photo' }, exec)
  assert.equal(saved[0].mediaType, 'image/png')
  assert.equal(saved[0].name, 'photo.png')
})

test('rejects HEIC with an actionable message instead of guessing', async () => {
  const { agent } = agentFor()
  const { services } = fakeServices({ agents: { list: () => [agent] } })
  const { ctx } = makeCtx(services)
  apply(ctx, { loadSharp: () => fakeSharp() })
  const tool = agent.registered[0]

  await assert.rejects(
    () => tool.execute({ file_path: 'photo.heic' }, exec),
    (error) => error.code === 'IMAGE_UNSUPPORTED_FORMAT' && /HEVC/.test(error.message),
  )
})

test('rejects unknown extensions and empty paths', async () => {
  const { agent } = agentFor()
  const { services } = fakeServices({ agents: { list: () => [agent] } })
  const { ctx } = makeCtx(services)
  apply(ctx, { loadSharp: () => fakeSharp() })
  const tool = agent.registered[0]

  await assert.rejects(
    () => tool.execute({ file_path: 'notes.txt' }, exec),
    (error) => error.code === 'IMAGE_UNSUPPORTED_FORMAT',
  )
  await assert.rejects(
    () => tool.execute({ file_path: '   ' }, exec),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
})

test('reports a route that cannot take images before touching the file', async () => {
  const { agent } = agentFor()
  const { services } = fakeServices({
    agents: { list: () => [agent] },
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) },
  })
  const { ctx } = makeCtx(services)
  apply(ctx, { loadSharp: () => fakeSharp() })
  const tool = agent.registered[0]

  await assert.rejects(
    () => tool.execute({ file_path: 'photo.avif' }, exec),
    (error) => error.code === 'IMAGE_UNSUPPORTED_MODEL',
  )
})

test('reports conversion failures and unavailable sharp distinctly', async () => {
  const { agent } = agentFor()
  const { services } = fakeServices({ agents: { list: () => [agent] } })
  const { ctx } = makeCtx(services)
  apply(ctx, { loadSharp: () => undefined })
  const tool = agent.registered[0]

  await assert.rejects(
    () => tool.execute({ file_path: 'photo.avif' }, exec),
    (error) => error.code === 'IMAGE_CONVERTER_UNAVAILABLE',
  )

  const second = agentFor()
  const secondServices = fakeServices({ agents: { list: () => [second.agent] } }).services
  const secondCtx = makeCtx(secondServices).ctx
  apply(secondCtx, {
    loadSharp: () => () => ({
      rotate() { return this },
      png() { return this },
      async toBuffer() { throw new Error('bad codec') },
    }),
  })
  await assert.rejects(
    () => second.agent.registered[0].execute({ file_path: 'photo.avif' }, exec),
    (error) => error.code === 'IMAGE_CONVERT_FAILED' && /bad codec/.test(error.message),
  )
})
