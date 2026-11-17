import { describe, expect, it } from 'vitest'
import { weevilRoutes } from './weevil.ts'

// The rising weevil questions were removed: an old app still open only ever hears « nothing », never a question.
describe('weevil — questions removed', () => {
  const call = async (method: string, path: string) => {
    const route = weevilRoutes((_res, status, body) => void (out = { status, body })).find(([m, re]) => m === method && re.test(path))
    let out: { status: number; body: unknown } | null = null
    expect(route).toBeTruthy()
    await route![2]({} as never, {} as never, new URL(`http://x${path}`), [])
    return out!
  }

  it('never serves a question', async () => {
    expect(await call('GET', '/api/weevil')).toEqual({ status: 200, body: { question: null } })
  })

  it('answers an old client calmly, without remembering anything', async () => {
    expect(await call('POST', '/api/weevil/abc/missed')).toEqual({ status: 200, body: { ok: true } })
    expect(await call('POST', '/api/weevil/abc/answer')).toEqual({ status: 200, body: { reply: '', learned: [], done: true } })
  })
})
