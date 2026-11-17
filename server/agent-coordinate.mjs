// Compatibility adapter for older agent workflows: canonical delivery owns signing and queueing.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const [target,file]=process.argv.slice(2)
const source=process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || process.env.CLAUDE_SESSION_ID
if(!source || !target || !file){
  console.error('An agent runtime, target session and message file are required.') // i18n-ignore: private compatibility CLI diagnostic
  process.exit(1)
}
const text=fs.readFileSync(file,'utf8')
const cli=process.env.WEEVILS_CLI || path.join(os.homedir(),'.local','bin','weevils')
const result=spawnSync(cli,['send',target,text],{stdio:'inherit',env:{...process.env,WEEVILS_FROM:'agent'}})
if(result.error)console.error(result.error.message)
process.exit(result.status ?? 1)
