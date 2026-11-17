import {execFileSync} from 'node:child_process'
import {it} from 'vitest'

it('exports canonical bytes reproducibly, detects staleness and rejects modified archives',()=>{
  execFileSync('python3',['-B','scripts/release_test.py'],{cwd:process.cwd(),timeout:30000,stdio:'pipe'})
})
