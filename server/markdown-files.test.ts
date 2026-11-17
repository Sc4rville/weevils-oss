import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MARKDOWN_LIMIT, readMarkdown, saveMarkdown } from './markdown-files.ts'
let root: string
beforeEach(() => { root=fs.mkdtempSync(path.join(os.tmpdir(),'markdown-edit-')); fs.writeFileSync(path.join(root,'ideas.md'),'# Idées\r\nTexte brut 🐛\r\n',{mode:0o640}) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root,{recursive:true,force:true}) })
it('saves exact Unicode/line endings atomically, preserves permissions, and replays a lost response',()=>{
 const first=readMarkdown(root,'ideas.md'),text=first.content+'Nouvelle idée\r\n'
 const saved=saveMarkdown(root,'ideas.md',text,first.revision)
 expect(saved.content).toBe(text);expect(saved.revision).not.toBe(first.revision)
 expect(fs.statSync(path.join(root,'ideas.md')).mode&0o777).toBe(0o640)
 expect(saveMarkdown(root,'ideas.md',text,first.revision).revision).toBe(saved.revision)
 expect(fs.readdirSync(root)).toEqual(['ideas.md'])
})
it('rejects a stale revision without changing the concurrent edit',()=>{
 const first=readMarkdown(root,'ideas.md')
 fs.writeFileSync(path.join(root,'ideas.md'),'Another editor saved')
 expect(()=>saveMarkdown(root,'ideas.md','My retained draft',first.revision)).toThrow(expect.objectContaining({status:409}))
 expect(fs.readFileSync(path.join(root,'ideas.md'),'utf8')).toBe('Another editor saved')
})
it('rejects traversal, symlinks, hardlinks, binary/invalid UTF8, non-Markdown and oversized input',()=>{
 fs.writeFileSync(path.join(root,'script.ts'),'code')
 fs.symlinkSync(path.join(root,'ideas.md'),path.join(root,'link.md'))
 fs.linkSync(path.join(root,'ideas.md'),path.join(root,'hard.md'))
 for(const name of ['../outside.md','/tmp/outside.md','link.md','hard.md','script.ts','.git/config.md','dist/export.md','build/generated.md','node_modules/package/README.md','generated/output.md']) expect(()=>readMarkdown(root,name)).toThrow()
 fs.unlinkSync(path.join(root,'hard.md'))
 const first=readMarkdown(root,'ideas.md')
 expect(()=>saveMarkdown(root,'ideas.md','x'.repeat(MARKDOWN_LIMIT+1),first.revision)).toThrow()
 expect(()=>saveMarkdown(root,'ideas.md','text',undefined)).toThrow()
 expect(()=>saveMarkdown(root,'ideas.md','\ud800',first.revision)).toThrow()
 fs.writeFileSync(path.join(root,'binary.md'),Buffer.from([255,0]))
 expect(()=>readMarkdown(root,'binary.md')).toThrow()
})
it('preserves original on commit failure and removes staging file',()=>{
 const first=readMarkdown(root,'ideas.md')
 vi.spyOn(fs,'renameSync').mockImplementationOnce(()=>{throw new Error('Disk failure')})
 expect(()=>saveMarkdown(root,'ideas.md','New text',first.revision)).toThrow('Disk failure')
 expect(readMarkdown(root,'ideas.md').content).toBe(first.content)
 expect(fs.readdirSync(root)).toEqual(['ideas.md'])
})
it('rechecks a concurrent editor after staging',()=>{
 const first=readMarkdown(root,'ideas.md'),write=fs.writeFileSync.bind(fs)
 vi.spyOn(fs,'writeFileSync').mockImplementationOnce((...args: Parameters<typeof fs.writeFileSync>)=>{
  write(...args);write(path.join(root,'ideas.md'),'New external version')
 })
 expect(()=>saveMarkdown(root,'ideas.md','My draft',first.revision)).toThrow(expect.objectContaining({status:409}))
 expect(fs.readFileSync(path.join(root,'ideas.md'),'utf8')).toBe('New external version')
 expect(fs.readdirSync(root)).toEqual(['ideas.md'])
})

it('does not expose generated Markdown or hidden secret directories as editable sources',()=>{
 for(const directory of ['dist','build','generated','node_modules/package','.secrets']) {
  fs.mkdirSync(path.join(root,directory),{recursive:true})
  fs.writeFileSync(path.join(root,directory,'notes.md'),'Keep generated or private material untouched')
  expect(()=>readMarkdown(root,`${directory}/notes.md`)).toThrow(expect.objectContaining({status:400}))
  expect(()=>saveMarkdown(root,`${directory}/notes.md`,'Overwrite','a'.repeat(64))).toThrow(expect.objectContaining({status:400}))
  expect(fs.readFileSync(path.join(root,directory,'notes.md'),'utf8')).toBe('Keep generated or private material untouched')
 }
})
