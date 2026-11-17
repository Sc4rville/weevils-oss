import fs from 'node:fs'
import { expect, it } from 'vitest'
// The model picker is rows of words in the page flow: the stylesheet must never lift it out of the flow (overlay,
// sheet, fixed bar) nor stop it from wrapping, which is what would spill it past a phone's edges or over the header,
// the input field or the bottom bar. The DOM half (rendered in place, no inline geometry) is in
// src/ui/model-controls.test.tsx.
const read=(p:string)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
it('keeps the model picker in the flow and wrapping on a phone-width screen',()=>{
 const own=read('src/ui/model-controls.css').replace(/\/\*[\s\S]*?\*\//g,'')
 expect(own).not.toMatch(/position\s*:|z-index|transform|translate|inset|100vw|white-space\s*:\s*nowrap|min-width\s*:\s*[1-9]/)
 expect(own).toMatch(/\.model-controls \.word \{[^}]*max-width: 100%[^}]*overflow-wrap: anywhere/)
 expect(own).toMatch(/\.model-controls \.word \{[^}]*white-space: normal/)
 const styles=read('src/styles.css')
 expect(styles).toMatch(/\.words \{[^}]*flex-wrap: wrap/)
 expect(styles).toMatch(/\.word\.pending \{[^}]*text-decoration/)
})
