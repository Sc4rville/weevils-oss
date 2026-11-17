// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const KEY = 'weevils-create-optimizer-id'
beforeEach(() => { vi.resetModules(); sessionStorage.clear(); localStorage.clear() })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('reuses the creation identity after a lost response and module reload, then clears it after confirmed creation', async () => {
 const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('connection lost')).mockResolvedValueOnce(new Response(JSON.stringify({item:{id:'same-draft'}}),{status:201}))
 vi.stubGlobal('fetch',fetcher)
 let {api} = await import('./api')
 await expect(api.createOptimizer()).rejects.toThrow('connection lost')
 const key = sessionStorage.getItem(KEY)
 expect(key).toBeTruthy()
 vi.resetModules(); ({api} = await import('./api'))
 expect((await api.createOptimizer()).item.id).toBe('same-draft')
 expect(fetcher.mock.calls.map(([,init])=>init.headers['Idempotency-Key'])).toEqual([key,key])
 expect(sessionStorage.getItem(KEY)).toBeNull()
 fetcher.mockResolvedValueOnce(new Response(JSON.stringify({item:{id:'next-draft'}}),{status:201}))
 await api.createOptimizer()
 expect(fetcher.mock.calls[2][1].headers['Idempotency-Key']).not.toBe(key)
})
it('shares one pending creation across double clicks', async () => {
 let release!: (r:Response)=>void
 const fetcher=vi.fn(()=>new Promise<Response>(r=>{release=r}))
 vi.stubGlobal('fetch',fetcher)
 const {api}=await import('./api')
 const first=api.createOptimizer(); const second=api.createOptimizer()
 expect(first).toBe(second);expect(fetcher).toHaveBeenCalledTimes(1)
 release(new Response(JSON.stringify({item:{id:'single'}}),{status:201}))
 await first;expect(sessionStorage.getItem(KEY)).toBeNull()
})
it.each([{status:503,body:{error:'unavailable'}},{status:200,body:{item:{id:'not-confirmed'}}},{status:201,body:{}}])('retains the identity on an unconfirmed response $status',async ({status,body})=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(body),{status})))
 const {api}=await import('./api')
 await expect(api.createOptimizer()).rejects.toThrow()
 expect(sessionStorage.getItem(KEY)).toBeTruthy()
})
it('does not send when the creation identity cannot be persisted',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher)
 const {api}=await import('./api')
 vi.spyOn(sessionStorage,'setItem').mockImplementation(()=>{throw new Error('storage blocked')})
 await expect(api.createOptimizer()).rejects.toThrow()
 expect(fetcher).not.toHaveBeenCalled()
})
