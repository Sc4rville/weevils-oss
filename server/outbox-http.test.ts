import { lang, withLang } from './i18n.ts'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { Outbox } from './outbox.ts'
import { executeOutbox, outboxRoute } from './outbox-http.ts'
it.each(['/api/main', '/api/foryou/item/act'])('accepts %s before delayed delivery and deduplicates a second click after lost acknowledgement', async (url) => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-http-outbox-'))
 let received = 0, finish!: () => void
 const routes: Parameters<typeof executeOutbox>[1] = [['POST', /^\/api\/(?:main|foryou\/item\/act)$/,  async (req,res) => {
   let body = ''; for await (const c of req) body += c
   expect(JSON.parse(body).text).toBe('1'); received++
   await new Promise<void>(r => { finish = r })
   res.writeHead(200); res.end(JSON.stringify({id:'same-thread'}))
 }]]
 const box = new Outbox(dir, task => executeOutbox(task, routes))
 const server = http.createServer(async (req,res) => {
   let body = ''; for await (const c of req) body += c
   const receipt = box.accept(String(req.headers['idempotency-key']), {url,body:JSON.parse(body),lane:'main'})
   res.writeHead(202, {'content-type':'application/json'});res.end(JSON.stringify(receipt))
 })
 await new Promise<void>(r => server.listen(0,'127.0.0.1',r))
 const port = (server.address() as {port:number}).port
 const send = () => fetch(`http://127.0.0.1:${port}/api/main`, {method:'POST',headers:{'Idempotency-Key':'same-mobile-message-123'},body:'{"text":"1"}'})
 try {
   const first = await send();expect(first.status).toBe(202);expect(((await first.json()) as {status:string}).status).toBe('accepted')
   const duplicate = await send();expect(((await duplicate.json()) as {status:string}).status).toBe('delivering')
   expect(received).toBe(1)
   finish();await new Promise<void>(r=>setImmediate(r));await new Promise<void>(r=>setImmediate(r))
   expect(box.get('same-mobile-message-123')).toMatchObject({status:'delivered',result:{id:'same-thread'}})
 } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(dir,{recursive:true,force:true})}
})
it('only wraps the explicit message and request-action routes', () => {
 for(const url of ['/api/main','/api/main/attach','/api/sessions/x/send','/api/sessions/x/attach','/api/foryou/x/reply','/api/foryou/x/act'])expect(outboxRoute(url)).toBe(true)
 for(const url of ['/api/login','/api/config','/api/sessions','/api/outbox/x'])expect(outboxRoute(url)).toBe(false)
})

it('replays the persisted app locale after await even when the worker uses another locale',async()=>{
 const routes:Parameters<typeof executeOutbox>[1]=[['POST',/^\/api\/main$/,async(req,res)=>{
  await Promise.resolve()
  expect(lang()).toBe('fr')
  expect(req.headers['x-weevils-locale']).toBe('fr')
  res.end(JSON.stringify({id:'original'}))
 }]]
 await withLang('en',()=>executeOutbox({url:'/api/main',body:{text:'hello'},lane:'main',locale:'fr'},routes))
})
