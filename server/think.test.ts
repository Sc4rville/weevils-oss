import {it,expect} from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {ThinkStore} from './think.ts'
import {emptyBoard} from '../shared/think.ts'
it('persists reloads and rejects stale writes without replacing the saved board',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'think-'));try{const file=path.join(dir,'board.json'),s=new ThinkStore(file),a=emptyBoard();expect(s.write(a)?.revision).toBe(1);expect(s.write(a)).toBeNull();expect(new ThinkStore(file).read().revision).toBe(1);fs.writeFileSync(file,'broken');expect(()=>s.read()).toThrow();expect(()=>s.write(a)).toThrow();expect(fs.readFileSync(file,'utf8')).toBe('broken')}finally{fs.rmSync(dir,{recursive:true,force:true})}})
