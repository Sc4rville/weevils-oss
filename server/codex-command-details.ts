/** Static tokenization only. Never execute the orchestration program. */
type Token = { value: string; literal?: boolean }
function tokens(code: string): Token[] {
  const out: Token[] = []
  const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g
  for (const m of code.matchAll(re)) {
    const raw=m[0]
    if(raw.startsWith('//')||raw.startsWith('/*'))continue
    if (/^["'`]/.test(raw)) {
      if(raw[0]==='`' && raw.includes('${')) {out.push({value:'',literal:true});continue}
      let value=raw.slice(1,-1).replace(/\\([\\'"`])/g,'$1').replace(/\\n/g,'\n')
      if(raw[0]==='"')try{value=JSON.parse(raw)}catch{ /* malformed literals are never evaluated */ }
      out.push({value,literal:true})
    } else out.push({value:raw})
  }
  return out
}
export interface NestedCall {name:string; command?:string; description?:string}
export function nestedCalls(input: unknown): NestedCall[] {
  const obj=input && typeof input==='object'? input as Record<string,unknown>:{}
  const code=typeof input==='string'?input:typeof obj.code==='string'?obj.code:typeof obj.input==='string'?obj.input:''
  const ts=tokens(code), calls:NestedCall[]=[]
  for(let i=0;i<ts.length-3;i++) {
    if(ts[i].literal||ts[i].value!=='tools'||ts[i+1].value!=='.'||ts[i+2].literal||ts[i+3].value!=='(')continue
    const call:NestedCall={name:ts[i+2].value}
    if(ts[i+4]?.value==='{') {
      let depth=1
      for(let j=i+5;j<ts.length && depth;j++) {
        const token=ts[j]
        if(depth===1 && ['cmd','description'].includes(token.value) && ts[j+1]?.value===':' && ts[j+2]?.literal && [',','}'].includes(ts[j+3]?.value)) {
          const key=token.value==='cmd'?'command':'description'
          call[key]=ts[j+2].value || undefined
        }
        if(!token.literal && ['{','[','('].includes(token.value))depth++
        if(!token.literal && ['}',']',')'].includes(token.value))depth--
      }
    }
    calls.push(call)
  }
  return calls
}
/** Redact before data crosses the API boundary, not just in the renderer. */
export function redactToolText(text:string,limit=8000):string {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,'[redacted]')
    .replace(/\b(Bearer)\s+[^\s"']+/gi,'$1 [redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[redacted]@')
    .replace(/\b(sk-[a-zA-Z0-9_-]{8,}|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)\b/g,'[redacted]')
    .replace(/([\w-]*(?:token|password|passwd|secret|api[_-]?key|authorization|cookie)[\w-]*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}]+)/gi,'$1[redacted]')
    .slice(0,limit)
}
export function commandDetails(name:string,input:unknown,limit=8000):string[] {
  const obj=input && typeof input==='object'? input as Record<string,unknown>:{}
  const raw=obj.cmd??obj.command
  const commands=name.split('.').at(-1)==='exec'?nestedCalls(input).map(c=>c.command):['exec_command','shell','local_shell','local_shell_call'].includes(name.split('.').at(-1)??'')?[Array.isArray(raw)?raw.join(' '):raw]:[]
  return commands.filter((c):c is string=>typeof c==='string'&&!!c).map(c=> /(?:\.env\b|credentials|printenv|\/proc\/.*environ|PRIVATE KEY)/i.test(c)?'[redacted]':redactToolText(c,limit))
}

/** Codex persists custom-tool results as input_text blocks, ordinary RPC results as text. */
function rawToolOutput(value:unknown,depth=0):string {
  if(depth>5)return ''
  if(typeof value==='string') {
    try { const parsed=JSON.parse(value);if(parsed!==value)return rawToolOutput(parsed,depth+1) } catch { /* ordinary tool output */ }
    return value
  }
  if(Array.isArray(value))return value.map(block=>rawToolOutput(block,depth+1)).filter(Boolean).join('\n')
  if(value && typeof value==='object') {
    const v=value as Record<string,unknown>
    if(['text','input_text','output_text'].includes(String(v.type)) && typeof v.text==='string')return rawToolOutput(v.text,depth+1)
    return rawToolOutput(v.output??v.stdout??v.content,depth+1)
  }
  return ''
}
export function toolOutputDetails(value:unknown):{output:string;outputTruncated:boolean} {
  const text=redactToolText(rawToolOutput(value),Infinity)
  return {output:text.slice(0,8000),outputTruncated:text.length>8000}
}
export function toolOutputText(value:unknown):string {return toolOutputDetails(value).output}

/** A shell summary exposes executable names and known subcommands, never paths or argument values.
 * Shell bodies/heredocs are deliberately not interpreted. The full recorded command remains opt-in. */
export function commandSummaries(commands:string[]):string[] {
  const names:string[]=[]
  for(const command of commands) {
    const segments:string[]=[];let start=0,quote='',escaped=false
    for(let i=0;i<command.length;i++) {
      const c=command[i]
      if(escaped){escaped=false;continue}
      if(c==='\\'&&quote!=="'"){escaped=true;continue}
      if(quote){if(c===quote)quote='';continue}
      if(['"',"'",'`'].includes(c)){quote=c;continue}
      if(c===';'||c==='\n'||c==='|'||c==='&') {
        const segment=command.slice(start,i);segments.push(segment);start=i+1
        if(segment.includes('<<')){start=command.length;break}
      }
    }
    segments.push(command.slice(start))
    for(let segment of segments) {
      segment=segment.trim().replace(/^env\s+/,'').replace(/^(?:[A-Za-z_][\w]*=(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)\s+)+/,'').replace(/^heavy\s+/,'')
      const m=/^((?:\/[\w.-]+)*\/?[A-Za-z][\w.+-]*)(?=\s|$)(?:\s+([a-z][\w-]*))?(?:\s+([a-z][\w-]*))?/.exec(segment)
      if(!m)continue
      const bin=m[1].split('/').at(-1)!
      if(['if','then','else','fi','for','do','done','while','case','esac','function'].includes(bin))continue
      const allowed:Record<string,string[]>={git:['status','diff','log','show','branch','worktree','fetch','rebase','merge','push','commit','add'],npm:['test','run','install','ci'],pnpm:['test','run','install','build'],yarn:['test','run','install','build'],bun:['test','run','install','build'],systemctl:['show','status','restart','start','stop'],docker:['ps','inspect','stats','build']}
      let summary=bin
      if(allowed[bin]?.includes(m[2]))summary+=' '+m[2]
      if(['npm','pnpm','yarn','bun'].includes(bin)&&m[2]==='run'&&['test','check','lint','typecheck','build','dev'].includes(m[3]))summary+=' '+m[3]
      if(!names.includes(summary))names.push(summary)
    }
  }
  return names.slice(0,3)
}
export function callDetails(name:string,input:unknown):{name:string;description?:string}[] {
  const obj=input&&typeof input==='object'?input as Record<string,unknown>:{}
  const calls=name.split('.').at(-1)==='exec'?nestedCalls(input):[{name,description:typeof obj.description==='string'?obj.description:undefined}]
  return calls.filter(c=>/^[a-zA-Z_][a-zA-Z_0-9.]*$/.test(c.name)).map(c=>({name:c.name,...(c.description?{description:redactToolText(c.description,300)}:{})}))
}
