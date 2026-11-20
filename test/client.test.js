import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function loadClient() {
  let captured
  const listeners = new Map()
  const removed = []
  const document = {
    addEventListener(type, listener, capture) {
      listeners.set(type, { listener, capture })
    },
    removeEventListener(type, listener, capture) {
      removed.push({ type, listener, capture })
    },
  }
  class FakeElement {}
  class FakeInput extends FakeElement {}
  class FakeDataTransfer {
    constructor() {
      this._files = []
      this.items = { add: (file) => { this._files.push(file) } }
    }

    get files() {
      return this._files
    }
  }

  const sandbox = {
    window: { __ModuleLoader__: { load: (options) => { captured = options } } },
    document,
    console,
    File: class File {
      constructor(parts, name, options) {
        this.name = name ?? 'file'
        this.type = options?.type ?? ''
        this.lastModified = options?.lastModified ?? 0
        this.size = 0
      }
    },
    Element: FakeElement,
    HTMLInputElement: FakeInput,
    Event: class Event {
      constructor(type, init) {
        this.type = type
        this.bubbles = init?.bubbles === true
      }
    },
    URL,
    DataTransfer: FakeDataTransfer,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(source, sandbox)
  assert.equal(captured.id, 'dsh-image-formats')
  const module = captured.factory(() => { throw new Error('no imports expected') })
  return { module, listeners, removed, window: sandbox.window, sandbox }
}

test('loads as a DSH client module', () => {
  const { module } = loadClient()
  assert.equal(module.name, 'image-formats')
  assert.ok(Array.isArray(module.inject))
  assert.equal(module.inject.length, 0)
  assert.equal(typeof module.apply, 'function')
})

test('installs capture listeners and removes them through ctx.effect', () => {
  const { module, listeners, removed, window } = loadClient()
  let cleanup
  const ctx = {
    effect(factory, label) {
      assert.equal(label, 'image-formats: composer intake')
      cleanup = factory()
    },
  }
  module.apply(ctx)
  for (const type of ['paste', 'drop', 'change']) {
    assert.ok(listeners.has(type), type + ' listener is installed')
    assert.equal(listeners.get(type).capture, true)
  }
  assert.equal(typeof window.__dshImageFormatsDispose, 'function')
  assert.equal(typeof cleanup, 'function')
  cleanup()
  assert.equal(removed.length, 3)
})

test('feeds a failed conversion back only once instead of re-entering the change listener', async () => {
  const { module, listeners, sandbox } = loadClient()
  module.apply({})

  const card = { isConnected: true }
  const input = new sandbox.HTMLInputElement()
  input.type = 'file'
  input.disabled = false
  input.files = [new sandbox.File([], 'broken.avif', { type: 'image/avif' })]
  input.closest = (selector) => selector === '[data-composer-card="true"]' ? card : null
  card.querySelector = () => input

  sandbox.createImageBitmap = () => Promise.reject(new Error('no decoder'))

  let dispatches = 0
  input.dispatchEvent = (event) => {
    dispatches += 1
    if (dispatches > 1) throw new Error('the plugin re-entered its own change event')
    listeners.get('change').listener(event)
    return true
  }

  const event = {
    target: input,
    defaultPrevented: false,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  }
  listeners.get('change').listener(event)
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(dispatches, 1)
})

test('trusts a declared non-AVIF MIME over an avif filename', () => {
  const { module, listeners, sandbox } = loadClient()
  module.apply({})

  const card = { isConnected: true }
  const input = new sandbox.HTMLInputElement()
  input.type = 'file'
  input.files = [new sandbox.File([], 'photo.avif', { type: 'image/png' })]
  input.closest = (selector) => selector === '[data-composer-card="true"]' ? card : null

  let prevented = 0
  const event = {
    target: input,
    defaultPrevented: false,
    preventDefault() { prevented += 1 },
    stopPropagation() {},
    stopImmediatePropagation() {},
  }
  listeners.get('change').listener(event)

  assert.equal(prevented, 0)
})
