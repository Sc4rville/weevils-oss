import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { Resvg } from '@resvg/resvg-js'
import { expect, it } from 'vitest'
const exports=JSON.parse(fs.readFileSync('public/branding/exports.json','utf8'))
it('exports the approved logo with correct sizes, opaque PWA backgrounds and a transparent favicon',()=>{
 expect(createHash('sha256').update(fs.readFileSync('public/branding/weevboss-cutout.png')).digest('hex')).toBe(exports.sourceSha256)
 for(const [name,meta] of Object.entries(exports.files) as [string,{width:number;height:number;sha256:string}][]){
  const file=fs.readFileSync(`public/${name}`)
  expect(file.readUInt32BE(16)).toBe(meta.width);expect(file.readUInt32BE(20)).toBe(meta.height)
  expect(createHash('sha256').update(file).digest('hex')).toBe(meta.sha256)
  const size=meta.width
  const raster=new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><image href="data:image/png;base64,${file.toString('base64')}" width="${size}" height="${size}"/></svg>`).render()
  const pixels=raster.pixels
  if(size===32){expect(pixels[3]).toBe(0);expect([...pixels].filter((v,i)=>i%4===3&&v>0).length).toBeGreaterThan(250)}
  else {
   let mark=0
   for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const i=(y*size+x)*4;expect(pixels[i+3]).toBe(255)
    if(Math.abs(pixels[i]-179)>3||Math.abs(pixels[i+1]-155)>3||Math.abs(pixels[i+2]-255)>3){
     mark++;expect(Math.hypot(x-size/2,y-size/2)).toBeLessThan(size*.4)
    }
   }
   expect(mark).toBeGreaterThan(size*size*.12)
  }
 }
})
it('versions all installed-icon URLs by their bytes without service worker caching',()=>{
 const html=fs.readFileSync('index.html','utf8'),manifest=JSON.parse(fs.readFileSync('public/manifest.webmanifest','utf8')),sw=fs.readFileSync('public/sw.js','utf8')
 for(const name of ['favicon-32.png','icon-180.png'])expect(html).toContain(`/${name}?v=${exports.files[name].sha256.slice(0,12)}`)
 for(const icon of manifest.icons){const name=icon.src.split('/').at(-1).split('?')[0];expect(icon.src).toBe(`/${name}?v=${exports.files[name].sha256.slice(0,12)}`)}
 expect(sw).toContain(`/icon-192.png?v=${exports.files['icon-192.png'].sha256.slice(0,12)}`)
 expect(sw).not.toContain('caches.open(')
})
