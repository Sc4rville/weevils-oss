import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { OutboxError } from './outbox.ts'
import { markdownFileRoutes, readMarkdown } from './markdown-files.ts'
it('normal HTTP file routes save and reject a stale phone edit on an isolated repository',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'markdown-http-'))
 const file=path.join(dir,'idea.md');fs.writeFileSync(file,'Idée brute originale')
 const json=(res:http.ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
 let blocked = false
 const checked:string[]=[]
 const routes=markdownFileRoutes({assertRepoExecution:repo=>{checked.push(repo);if(blocked)throw new OutboxError(403,'Source is read-only')},remoteById:()=>undefined,repoDir:repo=>{if(repo!=='fixture')throw new Error('Unknown repo');return dir},file:async()=>{throw new Error('Read fallback should not run')}},json,async req=>{let s='';for await(const part of req)s+=part;return JSON.parse(s)})
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://local')
  const route=routes.find(([method,re])=>method===req.method&&re.test(url.pathname))
  if(!route)return json(res,404,{})
  try {await route[2](req,res,url,route[1].exec(url.pathname)!.slice(1))}catch(e){json(res,e instanceof OutboxError?e.status:400,{error:(e as Error).message})}
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/repos/fixture/file?path=idea.md&machine=vps`
 const put=(content:string,revision:string)=>fetch(url,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content,revision})})
 try {
  const initial=await(await fetch(url)).json() as ReturnType<typeof readMarkdown>
  expect(checked).toEqual([]) // Reading never requires execution rights.
  expect(initial.editable).toBe(true)
  expect(initial.content).toBe('Idée brute originale')
  blocked=true
  expect((await put('Must not be written',initial.revision)).status).toBe(403)
  expect(checked).toEqual(['fixture'])
  expect(fs.readFileSync(file,'utf8')).toBe('Idée brute originale')
  expect(fs.readdirSync(dir)).toEqual(['idea.md'])
  expect((await fetch(url)).status).toBe(200)
  expect(checked).toEqual(['fixture'])
  blocked=false
  const saved=await put('Idée modifiée',initial.revision);expect(saved.status).toBe(200)
  const version=await saved.json() as ReturnType<typeof readMarkdown>;expect(version.content).toBe('Idée modifiée')
  const stale=await put('Un autre téléphone',initial.revision);expect(stale.status).toBe(409)
  expect(fs.readFileSync(file,'utf8')).toBe('Idée modifiée')
  expect((await put('Idée modifiée',initial.revision)).status).toBe(200)
  const reopened=await(await fetch(url)).json() as ReturnType<typeof readMarkdown>;expect(reopened.revision).toBe(version.revision)
  expect(reopened.content).toBe('Idée modifiée')
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));fs.rmSync(dir,{recursive:true,force:true})}
})
