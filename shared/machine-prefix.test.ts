import { expect, it } from 'vitest'
import { withoutMachinePrefix } from './machine-prefix.ts'
it('cleans the observed multiline handoff form without removing meaningful machine details',()=>{
 const text='[PC] État Git et transcript relus.\n[VPS] Une autre session Codex reprend déjà ce chantier.\nLe rendu tourne sur le GPU ; le navigateur reste sur le PC.'
 expect(withoutMachinePrefix(text)).toBe('État Git et transcript relus.\nUne autre session Codex reprend déjà ce chantier.\nLe rendu tourne sur le GPU ; le navigateur reste sur le PC.')
 expect(withoutMachinePrefix('[VPS] [GPU] Ready')).toBe('Ready')
})
it('preserves quotations, fenced/indented code, links, reference definitions and IDs',()=>{
 const text='> [VPS] user quotation\n[GPU] quotation continuation\n\n"[PC] quoted"\n`[GPU] code`\n```text\n[VPS] code\n```\n~~~~\n[PC] code\n~~~~\n    [GPU] indented code\n\t[VPS] indented code\n[VPS](https://example.test)\n[VPS]: https://example.test\n[GPU]-job-123\n[VPS] Normal prose'
 expect(withoutMachinePrefix(text)).toBe(text.replace('[VPS] Normal prose','Normal prose'))
})
