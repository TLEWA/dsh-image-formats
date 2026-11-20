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
  const sandbox = {
    window: { __ModuleLoader__: { load: (options) => { captured = options } } },
    document,
    console,
    File: class File {},
    Element: class Element {},
    HTMLInputElement: class HTMLInputElement {},
    URL,
    DataTransfer: class DataTransfer {},
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(source, sandbox)
  assert.equal(captured.id, 'dsh-image-formats')
  const module = captured.factory(() => { throw new Error('no imports expected') })
  return { module, listeners, removed, window: sandbox.window }
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
