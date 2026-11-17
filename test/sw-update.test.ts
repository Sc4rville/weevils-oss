import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { expect, it, vi } from 'vitest'

it('defers an update while a composer holds a draft or awaits acknowledgement', async () => {
  const navigate = vi.fn(async () => {})
  let reply: string | { build: string; editing: boolean; safeToReload?: boolean } = { build: 'old.js', editing: true }
  const retry = vi.fn()
  const client = { url: 'https://example.test/', navigate, postMessage: (_: unknown, ports: { reply: (value: unknown) => void }[]) => ports[0].reply(reply) }
  class Channel {
    port1 = { onmessage: null as null | ((event: { data: unknown }) => void) }
    port2 = { reply: (value: unknown) => this.port1.onmessage?.({ data: value }) }
  }
  const context = vm.createContext({
    self: { addEventListener: vi.fn(), clients: { matchAll: async () => [client] } },
    MessageChannel: Channel, setTimeout: retry, clearTimeout: vi.fn(),
  })
  vm.runInContext(readFileSync('public/sw.js', 'utf8').replace('__WEEVILS_BUILD__', 'new.js'), context)
  await vm.runInContext('reloadStale()', context)
  expect(navigate).not.toHaveBeenCalled()
  expect(retry).toHaveBeenCalledWith(expect.any(Function), 5000)
  reply = 'old.js'
  await vm.runInContext('reloadStale()', context)
  expect(navigate).not.toHaveBeenCalled()
  reply = { build: 'old.js', editing: false, safeToReload: true }
  await vm.runInContext('reloadStale()', context)
  expect(navigate).toHaveBeenCalledTimes(1)
})

it.each(['check-build', 'notification-state'])('rechecks an already active worker on %s after a suspended retry', async type => {
 const navigate = vi.fn(async () => {})
 let reply = { build: 'old.js', editing: true, safeToReload: false }
 const listeners: Record<string, (event: any) => void> = {}
 const client = { url: 'https://example.test/#for-you', navigate, postMessage: (_: unknown, ports: { reply: (value: unknown) => void }[]) => ports[0].reply(reply) }
 class Channel {
  port1 = { onmessage: null as null | ((event: { data: unknown }) => void) }
  port2 = { reply: (value: unknown) => this.port1.onmessage?.({ data: value }) }
 }
 const context = vm.createContext({
  self: { addEventListener: (name: string, fn: (event: any) => void) => { listeners[name] = fn }, clients: { matchAll: async () => [client] }, registration: { getNotifications: async () => [] } },
  MessageChannel: Channel, setTimeout: vi.fn(), clearTimeout: vi.fn(),
 })
 vm.runInContext(readFileSync('public/sw.js', 'utf8').replace('__WEEVILS_BUILD__', 'new.js'), context)
 const dispatch = async () => {
  let done: Promise<unknown> = Promise.resolve()
  listeners.message({ data: { type }, waitUntil: (promise: Promise<unknown>) => { done = promise } })
  await done
 }
 await dispatch()
 expect(navigate).not.toHaveBeenCalled()
 // The scheduled retry never runs (as when iOS suspends the worker).
 reply = { build: 'old.js', editing: false, safeToReload: true }
 await dispatch()
 expect(navigate).toHaveBeenCalledWith(client.url)
 navigate.mockClear()
 reply = { build: 'new.js', editing: false, safeToReload: true }
 await dispatch()
 expect(navigate).not.toHaveBeenCalled()
})
