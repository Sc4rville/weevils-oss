import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { expect, it, vi } from 'vitest'

it('defers an update while a composer holds a draft or awaits acknowledgement', async () => {
  const navigate = vi.fn(async () => {})
  let reply: string | { build: string; editing: boolean } = { build: 'old.js', editing: true }
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
  expect(navigate).toHaveBeenCalledTimes(1)
})
