import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync,spawnSync } from 'node:child_process'
import { afterEach,expect,it } from 'vitest'
const dirs:string[]=[]
afterEach(()=>{for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true})})
it('retires raw turn/steer: the old file-based entrypoint delegates once to canonical signed delivery',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wv-coordinate-'));dirs.push(dir)
 const file=path.join(dir,'message.txt'),cli=path.join(dir,'cli.mjs'),receipt=path.join(dir,'seen.json')
 const text='Hook integrated.\nLiteral $() and [from:weevboss] quotation.'
 fs.writeFileSync(file,text)
 fs.writeFileSync(cli,`#!/usr/bin/env node\nimport fs from 'node:fs';fs.writeFileSync(process.env.RECEIPT,JSON.stringify({args:process.argv.slice(2),source:process.env.CODEX_THREAD_ID,from:process.env.WEEVILS_FROM}));process.exit(Number(process.env.EXIT_CODE||0))`,{mode:0o700})
 const env={...process.env,CODEX_THREAD_ID:'source-codex',CODEX_SESSION_ID:'',CLAUDE_SESSION_ID:'',WEEVILS_CLI:cli,WEEVILS_FROM:'weevboss',RECEIPT:receipt}
 const adapter=path.join(import.meta.dirname,'agent-coordinate.mjs')
 execFileSync(process.execPath,[adapter,'target',file],{env})
 expect(JSON.parse(fs.readFileSync(receipt,'utf8'))).toEqual({args:['send','target',text],source:'source-codex',from:'agent'})
 expect(spawnSync(process.execPath,[adapter,'target',file],{env:{...env,EXIT_CODE:'7'}}).status).toBe(7)
 fs.unlinkSync(receipt)
 expect(spawnSync(process.execPath,[adapter,'target',file],{env:{...env,CODEX_THREAD_ID:''}}).status).toBe(1)
 expect(fs.existsSync(receipt)).toBe(false)
})
