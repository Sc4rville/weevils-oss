// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Tile } from './softwares'
import type { Software } from '../../shared/softwares'
const sw: Software={id:'test:demo',name:'A long software name',kind:'web',machine:'test',repo:'/demo',repos:[],run:'running',tail:['$ git log','sgnl://private-link','SECRET_TOKEN=fixture'],tailSource:'log',hosts:[],lastCommitAt:0,lastActivityAt:0,blurb:'An interface for the project',progress:{phase:2,percent:50,source:'heuristic',reason:'',at:0}}
it('shows an honest empty state and human context, never terminal output',()=>{
 const html=renderToStaticMarkup(<Tile sw={sw} slot={0} onOpen={()=>{}} />)
 expect(html).toContain(sw.name);expect(html).toContain(sw.blurb)
 expect(html).toContain('sw-empty');expect(html).toContain('sw-state');expect(html).toContain('sw-progress-label')
 for(const line of sw.tail)expect(html).not.toContain(line)
 expect(html).not.toContain('sw-term')
})
it('retains an available real image regardless of software classification',()=>{
 const html=renderToStaticMarkup(<Tile sw={{...sw,kind:'service',shot:123}} slot={0} onOpen={()=>{}} />)
 expect(html).toContain('<img');expect(html).not.toContain('sw-empty')
 expect(html).not.toContain('SECRET_TOKEN')
})
it('falls back to readable context when a cached screenshot cannot load', async()=>{
 const {createRoot}=await import('react-dom/client')
 const {act}=await import('react')
 ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try {
  await act(async()=>root.render(<Tile sw={{...sw,shot:123}} slot={0} onOpen={()=>{}} />))
  await act(async()=>host.querySelector('img')!.dispatchEvent(new Event('error')))
  expect(host.querySelector('img')).toBeNull()
  expect(host.querySelector('.sw-empty')).not.toBeNull()
  expect(host.textContent).not.toContain('SECRET_TOKEN')
 } finally {await act(async()=>root.unmount());host.remove()}
})
