import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function loadClient() {
  let captured
  const listeners = new Map()
  const activeListeners = new Map()
  const removed = []
  const document = {
    addEventListener(type, listener, capture) {
      listeners.set(type, { listener, capture })
      activeListeners.set(type, listener)
    },
    removeEventListener(type, listener, capture) {
      removed.push({ type, listener, capture })
      if (activeListeners.get(type) === listener) activeListeners.delete(type)
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
  return { module, listeners, activeListeners, removed, window: sandbox.window, sandbox }
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

test('does not let a superseded install remove the current listeners', () => {
  const { module, activeListeners } = loadClient()
  let cleanup
  module.apply({
    effect(factory) {
      cleanup = factory()
    },
  })
  module.apply({})
  assert.equal(activeListeners.size, 3)

  cleanup()
  assert.equal(activeListeners.size, 3)
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

test('does not intercept a paste outside the composer', () => {
  const { module, listeners, sandbox } = loadClient()
  module.apply({})

  const outside = new sandbox.Element()
  outside.closest = () => null
  let prevented = 0
  const event = {
    target: outside,
    defaultPrevented: false,
    clipboardData: {
      files: [new sandbox.File([], 'outside.avif', { type: 'image/avif' })],
      getData: () => '',
    },
    preventDefault() { prevented += 1 },
    stopPropagation() {},
    stopImmediatePropagation() {},
  }
  listeners.get('paste').listener(event)

  assert.equal(prevented, 0)
})

test('stops feeding files after the plugin is disposed', async () => {
  const { module, listeners, sandbox } = loadClient()
  let cleanup
  module.apply({
    effect(factory) {
      cleanup = factory()
    },
  })

  const card = { isConnected: true }
  const input = new sandbox.HTMLInputElement()
  input.type = 'file'
  input.disabled = false
  input.files = [new sandbox.File([], 'late.avif', { type: 'image/avif' })]
  input.closest = (selector) => selector === '[data-composer-card="true"]' ? card : null
  card.querySelector = () => input

  let resolveBitmap
  sandbox.createImageBitmap = () => new Promise((resolve) => { resolveBitmap = resolve })
  sandbox.document.createElement = () => ({
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toBlob(callback) { callback({ size: 10 }) },
  })

  let dispatches = 0
  input.dispatchEvent = () => { dispatches += 1; return true }
  const event = {
    target: input,
    defaultPrevented: false,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  }
  listeners.get('change').listener(event)
  cleanup()
  resolveBitmap({ width: 10, height: 10, close() {} })
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(dispatches, 0)
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


function fakeSlots() {
  const slots = {
    entries_: [],
    spec: null,
    component: null,
    watcher: null,
    released: false,
    unregistered: 0,
    unsubscribed: 0,
  }
  let releaseEntry = null
  slots.entries = () => slots.entries_
  slots.inject = (key, factory) => {
    assert.equal(key, 'conversation.input.attachments')
    releaseEntry = factory()
    return () => {
      slots.released = true
      if (typeof releaseEntry === 'function') releaseEntry()
    }
  }
  slots.register = (spec, component) => {
    slots.spec = spec
    slots.component = component
    slots.entries_.push(component)
    return () => { slots.unregistered += 1 }
  }
  slots.subscribe = (key, listener) => {
    assert.equal(key, 'conversation.input.attachments')
    slots.watcher = listener
    return () => { slots.unsubscribed += 1 }
  }
  return slots
}

function composerHarness(sandbox) {
  const card = { isConnected: true }
  const input = new sandbox.HTMLInputElement()
  input.type = 'file'
  input.disabled = false
  input.files = [new sandbox.File([], 'shot.avif', { type: 'image/avif' })]
  input.closest = (selector) => (selector === '[data-composer-card="true"]' ? card : null)
  card.querySelector = () => input
  input.dispatches = 0
  input.dispatchEvent = () => { input.dispatches += 1; return true }
  sandbox.createImageBitmap = async () => ({ width: 8, height: 8, close() {} })
  sandbox.document.createElement = () => ({
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toBlob: (callback) => callback({ size: 16 }),
  })
  const event = {
    target: input,
    defaultPrevented: false,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  }
  return { input, event }
}

test('registers the attachment bridge in an empty host slot and releases it on dispose', () => {
  const { module } = loadClient()
  const slots = fakeSlots()
  let cleanup
  module.apply({
    slots,
    effect(factory) { cleanup = factory() },
  })

  assert.equal(slots.spec.name, 'conversation.input.attachments')
  assert.equal(typeof slots.component, 'function')
  cleanup()
  assert.equal(slots.released, true)
  assert.equal(slots.unsubscribed, 1)
  assert.equal(slots.unregistered, 1)
})

test('leaves the attachment cell to its occupant and keeps the DOM path', () => {
  const { module, listeners } = loadClient()
  const slots = fakeSlots()
  slots.entries_.push(() => null)
  let injected = 0
  slots.inject = () => { injected += 1; return () => {} }

  module.apply({ slots, effect: () => () => {} })

  assert.equal(injected, 0)
  assert.ok(listeners.has('change'))
})

test('waits for a slot service that arrives after the plugin applied', () => {
  const { module } = loadClient()
  const ctx = {
    effect: () => () => {},
    on(event, listener) {
      assert.equal(event, 'internal/service')
      ctx.listener = listener
      return () => { ctx.off = true }
    },
  }
  module.apply(ctx)
  const slots = fakeSlots()
  ctx.slots = slots
  ctx.listener('internal/service')
  assert.equal(slots.spec.name, 'conversation.input.attachments')
})

test('hands converted files to the slot intake instead of the hidden input', async () => {
  const { module, listeners, sandbox } = loadClient()
  const slots = fakeSlots()
  module.apply({ slots, effect: () => () => {} })

  const received = []
  slots.component({ onAddFiles: (files) => received.push(...files) })
  const { input, event } = composerHarness(sandbox)
  listeners.get('change').listener(event)
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(input.dispatches, 0)
  assert.equal(received.length, 1)
  assert.equal(received[0].type, 'image/png')
  assert.equal(received[0].name, 'shot.png')
})

test('falls back to the hidden input when the slot intake throws', async () => {
  const { module, listeners, sandbox } = loadClient()
  const slots = fakeSlots()
  module.apply({ slots, effect: () => () => {} })

  slots.component({ onAddFiles: () => { throw new Error('slot refused') } })
  const { input, event } = composerHarness(sandbox)
  listeners.get('change').listener(event)
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(input.dispatches, 1)
})

test('ignores owner props without a usable onAddFiles', () => {
  const { module } = loadClient()
  const slots = fakeSlots()
  module.apply({ slots, effect: () => () => {} })
  for (const props of [undefined, null, {}, { onAddFiles: 'nope' }]) {
    assert.doesNotThrow(() => slots.component(props))
  }
})
