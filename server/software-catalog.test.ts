import { expect, it, vi } from 'vitest'
import { Softwares } from './softwares.ts'
it('reads deployment metadata without launching, screenshots, model enrichment or marking the gallery active', async()=>{
 const sw=new Softwares({} as never), internal=sw as any
 internal.staticAt=Date.now()
 const assemble=vi.spyOn(internal,'assemble').mockResolvedValue(undefined)
 const enrich=vi.spyOn(internal,'enrich').mockResolvedValue(undefined)
 const catalog=await sw.catalog()
 expect(catalog.at).toBeGreaterThan(0)
 expect(catalog.items).toEqual([])
 expect(assemble).toHaveBeenCalledWith(true)
 expect(assemble).toHaveBeenCalledTimes(1)
 expect(enrich).not.toHaveBeenCalled()
 expect(internal.listAt).toBe(0)
 await sw.catalog()
 expect(assemble).toHaveBeenCalledTimes(1)
})
