import http from 'node:http'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { afterAll,beforeAll,expect,it } from 'vitest'
import { trustedFrom,trustedSource } from './http.ts'
import { threadAuthor,signAs,parseSigned } from './authors.ts'
const sources:Record<string,{tool:string;cwd:string}>={
 'project-codex':{tool:'codex',cwd:'/project'},'project-claude':{tool:'claude',cwd:'/project'},
 'boss-codex':{tool:'codex',cwd:'/orchestrator'},'boss-claude':{tool:'claude',cwd:'/orchestrator'},
}
let port=0
const seen:{body:any;author:string|undefined;signed:string}[]=[]
const server=http.createServer((req,res)=>{
 if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({sessions:[{id:'target'}]}));return}
 let data='';req.on('data',chunk=>data+=chunk).on('end',()=>{
  const body=JSON.parse(data)
  const author=trustedFrom(req,body,id=>threadAuthor(id,id=>sources[id],'boss-codex','/orchestrator'))
  seen.push({body,author,signed:author?signAs(author,body.text,trustedSource(req,body,id=>threadAuthor(id,id=>sources[id],'boss-codex','/orchestrator'))):body.text})
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:'target'}))
 })
})
beforeAll(async()=>{await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));port=(server.address() as {port:number}).port})
afterAll(()=>server.close())
const cli=(args:string[],env:Record<string,string>)=>new Promise<void>((resolve,reject)=>execFile('bash',[path.join(import.meta.dirname,'weevils-cli'),...args],{env:{PATH:process.env.PATH,HOME:process.env.HOME,WEEVILS_LANG:'en',WEEVILS_PORT:String(port),...env}},error=>error?reject(error):resolve()))
it('resolves real CLI send/new provenance for either tool without attributing project agents to weevboss',async()=>{
 for(const [source,author] of [['project-codex','codex'],['project-claude','claude'],['boss-codex','weevboss'],['boss-claude','weevboss']] as const){
  await cli(['send','target','A useful brief'],{[source.includes('claude')?'CLAUDE_SESSION_ID':'CODEX_THREAD_ID']:source})
  expect(seen.at(-1)?.body).toMatchObject({from:'agent',sourceThread:source})
  expect(parseSigned(seen.at(-1)!.signed)).toEqual({author,sourceThreadId:source,text:'A useful brief'})
 }
 await cli(['new','project','A new brief','codex'],{CODEX_SESSION_ID:'project-codex'})
 expect(seen.at(-1)?.author).toBe('codex')
 await cli(['send','target','Inherited boss claim'],{CODEX_THREAD_ID:'project-codex',WEEVILS_FROM:'weevboss'})
 expect(seen.at(-1)?.author).toBe('codex')
 expect(seen.at(-1)?.body.from).toBe('agent')
 await cli(['send','target','Unknown origin'],{})
 expect(seen.at(-1)?.author).toBe('agent')
 await cli(['send','target','Explicit legacy author'],{WEEVILS_FROM:'weevils'})
 expect(seen.at(-1)?.author).toBe('weevboss')
})
