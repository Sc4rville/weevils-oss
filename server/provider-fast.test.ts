import fs from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
const failure = vi.hoisted(() => ({ enabled: false }))
const invocations = vi.hoisted(() => [] as { args: string[]; options: { cwd: string; env?: Record<string, string> }; schema?: object }[])
const commands=vi.hoisted(()=>[] as string[])
vi.mock('./provider.ts',async orig=>({...await orig<typeof import('./provider.ts')>(),providerStatus:()=>({installed:true,logged:true})}))
vi.mock('node:child_process',()=>({execFile:(command:string,args:string[],_options:unknown,cb:(err:null,out:string)=>void)=>{
 commands.push(command)
 if(command==='codex') invocations.push({args,options:_options as never,...(args.includes('--output-schema')?{schema:JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'))}:{})})
 if(command==='codex')fs.writeFileSync(args[args.indexOf('-o')+1],'Codex answer')
 queueMicrotask(()=>cb(failure.enabled ? Object.assign(new Error('private command'), {code:1}) as never : null,'Claude answer'))
 return {stdin:{end(){}}}
}}))
import {haiku,smart,quick} from './fast.ts'
import {setProviderRoute} from './provider.ts'
afterEach(()=>{setProviderRoute(tool=>tool);vi.unstubAllEnvs();commands.length=0;invocations.length=0;failure.enabled=false})
it('routes every text helper to the explicitly selected subscription',async()=>{
 vi.stubEnv('WEEVILS_PROVIDER','codex')
 expect(await haiku('brief')).toBe('Codex answer')
 expect(await smart('plan')).toBe('Codex answer')
 expect(await quick('question')).toBe('Codex answer')
 expect(commands).toEqual(['codex','codex','codex'])
})
it('preserves Claude helpers by default',async()=>{
 vi.stubEnv('WEEVILS_PROVIDER','claude')
 expect(await haiku('brief')).toBe('Claude answer')
 expect(await smart('plan')).toBe('Claude answer')
 expect(commands).toEqual(['claude','claude'])
})

it('rejects a failed Codex process even when it wrote a partial answer',async()=>{
 vi.stubEnv('WEEVILS_PROVIDER','codex');failure.enabled=true
 await expect(smart('private prompt')).rejects.toThrow('model provider failure')
})

it('uses a private writable scratch directory and passes the requested output schema',async()=>{
 vi.stubEnv('WEEVILS_PROVIDER','codex')
 const schema={type:'object',properties:{items:{type:'array'}}}
 await smart('batch',120000,schema)
 const call=invocations[0]
 expect(call.options.cwd).toContain('/.cache/weevils/relay-')
 expect(call.options.env?.TMPDIR).toBe(call.options.cwd)
 expect(call.schema).toEqual(schema)
 expect(fs.existsSync(call.options.cwd)).toBe(false)
})

it('uses only the authorized subscription fallback and stops all helpers when neither is available', async()=>{
 vi.stubEnv('WEEVILS_PROVIDER','codex');vi.stubEnv('OPENAI_API_KEY','must-not-be-used')
 setProviderRoute(()=> 'claude')
 expect(await quick('question')).toBe('Claude answer')
 expect(commands).toEqual(['claude'])
 commands.length=0;setProviderRoute(()=>null)
 expect(()=>smart('kept work')).toThrow()
 expect(()=>haiku('kept work')).toThrow()
 await expect(quick('kept feedback')).rejects.toThrow()
 expect(commands).toEqual([])
 expect(process.env.WEEVILS_PROVIDER).toBe('codex')
})
