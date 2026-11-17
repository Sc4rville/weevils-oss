import fs from 'node:fs'
import { expect, it } from 'vitest'
const css = fs.readFileSync('src/styles.css','utf8')
type Lab = [number, number, number]
const linear = (v:number) => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4
function lab(value:string):Lab {
 if(value.startsWith('oklch')) {
  const [l,c,h]=value.match(/[\d.]+/g)!.map(Number)
  return [l,c*Math.cos(h*Math.PI/180),c*Math.sin(h*Math.PI/180)]
 }
 let hex=value.slice(1);if(hex.length===3)hex=[...hex].map(c=>c+c).join('')
 const [r,g,b]=[0,2,4].map(i=>linear(parseInt(hex.slice(i,i+2),16)/255))
 const l=Math.cbrt(.4122214708*r+.5363325363*g+.0514459929*b),m=Math.cbrt(.2119034982*r+.6806995451*g+.1073969566*b),s=Math.cbrt(.0883024619*r+.2817188376*g+.6299787005*b)
 return [.2104542553*l+.793617785*m-.0040720468*s,1.9779984951*l-2.428592205*m+.4505937099*s,.0259040371*l+.7827717662*m-.808675766*s]
}
function linearRGB([L,a,b]:Lab) {
 const l=(L+.3963377774*a+.2158037573*b)**3,m=(L-.1055613458*a-.0638541728*b)**3,s=(L-.0894841775*a-1.291485548*b)**3
 const rgb=[4.0767416621*l-3.3077115913*m+.2309699292*s,-1.2684380046*l+2.6097574011*m-.3413193965*s,-.0041960863*l-.7034186147*m+1.707614701*s].map(v=>Math.max(0,Math.min(1,v)))
 return rgb
}
function luminance(c:Lab){const rgb=linearRGB(c);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2]}
it.each(['light','dark','zen','graphite'])('keeps all three logo planes legible on %s main and project bands', theme => {
 const block=css.slice(css.indexOf(`[data-theme='${theme}'] {`)).split('}')[0]
 const vars=Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m=>[m[1],m[2]]))
 const colour=(name:string):Lab=>{
  const value=vars[name]
  if(value.startsWith('var('))return colour(value.slice(6,-1))
  if(!value.startsWith('color-mix'))return lab(value)
  const m=value.match(/var\(--([\w-]+)\) (\d+)%.*, var\(--([\w-]+)\)/)!
  const a=colour(m[1]),b=colour(m[3]),p=Number(m[2])/100
  return a.map((v,i)=>v*p+b[i]*(1-p)) as Lab
 }
 const backgrounds=['agent',...Array.from({length:16},(_,i)=>'p'+i)].flatMap(key=>{
  const base=colour(key),delta=Number(vars.dl ?? css.match(/--dl:\s*([^;]+);/)![1])
  return [base,[base[0]+delta,base[1]*1.06,base[2]*1.06] as Lab]
 })
 const logo=fs.readFileSync('src/ui/logo.tsx','utf8')
 const channels=[...logo.matchAll(/feFunc[RGB][^\n]+ : "([^"]+)"/g)].map(m=>m[1].split(" ").map(Number))
 const apply=(rgb:number[])=>{
  for(const operation of vars['logo-filter'].matchAll(/([a-z]+)\(([\d.]+)\)/g)){
   const n=Number(operation[2]),[r,g,b]=rgb
   if(operation[1]==='brightness')rgb=rgb.map(v=>v*n)
   if(operation[1]==='invert')rgb=rgb.map(v=>v*(1-n)+(1-v)*n)
   if(operation[1]==='grayscale'){
    const gray=.2126*r+.7152*g+.0722*b;rgb=rgb.map(v=>v*(1-n)+gray*n)
   }
   if(operation[1]==='sepia')rgb=[.393*r+.769*g+.189*b,.349*r+.686*g+.168*b,.272*r+.534*g+.131*b].map((v,i)=>rgb[i]*(1-n)+v*n)
   rgb=rgb.map(v=>Math.max(0,Math.min(1,v)))
  }
  return rgb.map(linear)
 }
 for(const [index,face] of ['front','side','top'].entries()) {
  const [r,g,b]=apply(channels.map(c=>c[index])),foreground=.2126*r+.7152*g+.0722*b
  for(const bg of backgrounds){
   const background=luminance(bg),ratio=(Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05)
   expect(ratio,`${theme} ${face} contrast`).toBeGreaterThanOrEqual(3)
  }
 }
 const recording=lab(vars['anim-rec'] ?? css.match(/:root \{\s*--anim-rec:\s*([^;]+)/)![1])
 const ink=colour('ink')
 const mix=Number(css.match(/\.voice-logo\.rec \{[^}]+var\(--anim-rec\) (\d+)%/)![1])/100
 const base=linearRGB(recording.map((v,i)=>v*mix+ink[i]*(1-mix)) as Lab).map(v=>v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055)
 for(const shade of [.9,.95,1]) {
  const [r,g,b]=base.map(v=>linear(v*shade)),foreground=.2126*r+.7152*g+.0722*b
  for(const bg of backgrounds){
   const background=luminance(bg),ratio=(Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05)
   expect(ratio,`${theme} recording contrast ${shade} ${foreground} ${background} ${base}`).toBeGreaterThanOrEqual(3)
  }
 }

})
