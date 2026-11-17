import { tr } from './i18n.ts'
import M from './i18n/codex-tools.ts'
import { expect, it } from 'vitest'
import { codexToolLabel } from './codex-tool-label.ts'
it('describes known commands without exposing arguments or credentials', () => {
  expect(codexToolLabel('exec_command', { cmd: 'npm test -- SECRET_TOKEN=private' })).toBe(tr(M).test)
  expect(codexToolLabel('shell', { cmd: ['ls', '/private/account'] })).toBe(tr(M).read)
  expect(codexToolLabel('exec_command', { cmd: 'curl https://user:password@private/?token=secret' })).toBe(tr(M).command)
  expect(codexToolLabel('unknown-secret', { description: 'SECRET', prompt: 'PRIVATE' })).toBe(tr(M).tool)
})
it('recognises free-form orchestration without evaluating or displaying code', () => {
  expect(codexToolLabel('functions.exec', 'text(await tools.exec_command({cmd:"cat SECRET"})); await tools.apply_patch("PRIVATE")')).toBe(`${tr(M).read} · ${tr(M).edit}`)
  expect(codexToolLabel('exec', 'await tools.mcp__codex_tui__send_message_to_thread({prompt:"PRIVATE"})')).toBe(tr(M).message)
  expect(codexToolLabel('exec', 'throw new Error("SECRET")')).toBe(tr(M).command)
})
