// Render the real application CSS in Chromium. Optional browser tooling stays outside runtime dependencies.
// WEEVILS_PLAYWRIGHT: module URL/path; WEEVILS_BROWSER: Chromium executable; first argument: evidence directory.
import fs from 'node:fs'
import path from 'node:path'
import { linkCss, contrast } from '../shared/link-colors.ts'
import { PAGE_KINDS } from '../shared/pages.ts'
const { chromium } = await import(process.env.WEEVILS_PLAYWRIGHT || 'playwright')
const out = path.resolve(process.argv[2] || '/tmp/weevils-link-contrast')
fs.mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ ...(process.env.WEEVILS_BROWSER ? { executablePath: process.env.WEEVILS_BROWSER } : {}), args: ['--no-sandbox'] })
const css = ['src/ui/foryou.css', 'src/styles.css', 'src/ui/living-link.css'].map(f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8')).join('\n') + '\n' + linkCss()
const rows = []
try {
 for (const width of [390, 1280]) for (const theme of ['light', 'graphite', 'dark', 'zen']) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 })
  const surfaces = [...['agent', ...Array.from({length: 16}, (_,n)=>'p'+n), 'h24', 'devil', 'devil-reply', 'fy-ok', 'calm'].map(v=>({ name: v, cls: 'band', style: '--c:var(--'+v+');' })), { name: 'thread-boss', cls: 'band msg orch', style: '--c:var(--agent);' }, ...['#3fc1f0','#ff6b8a','#ffcc00','#a020ff'].map((who,i)=>({name:'thread-outside-'+i,cls:'band msg orch ext',style:'--c:var(--agent);--who:'+who+';'})), ...['#3fc1f0','#ff6b8a','#ffcc00','#a020ff'].map((who,i)=>({name:'for-you-author-'+i,cls:'band fy-item',style:'--c:oklch(from '+who+' calc(l * var(--fy-who-lm, 1) + var(--fy-who-la, 0)) calc(c * var(--fy-who-k, 1)) h);'})), ...[0,25,50,75,100].map(p=>({name:'for-you-gradient-'+p,cls:'band fy-item recursive-identity',style:'--c:var(--agent);background-position:'+p+'% 50%;'}))]
  await page.setContent('<!doctype html><html data-theme="'+theme+'"><head><meta charset="utf-8"></head><body><main id="matrix"></main></body></html>')
  await page.addStyleTag({content:css+'\n*{animation:none!important;transition:none!important}body{margin:0}#matrix{width:100%}.measure{height:60px!important;min-height:60px!important;padding:0!important;margin:0!important;position:relative}.measure a{display:block;position:absolute;left:4px;right:4px;height:20px;top:30px;background-clip:border-box!important;-webkit-background-clip:border-box!important;color:transparent;font-size:0}.measure .caption{position:absolute;top:6px;left:4px;font-size:10px}'} )
  await page.evaluate(({surfaces,kinds})=>{const m=document.getElementById('matrix');for(const s of surfaces)for(const kind of kinds){const d=document.createElement('div');d.className=s.cls+' measure';d.style.cssText=s.style;d.dataset.name=s.name;d.dataset.kind=kind;const cap=document.createElement('span');cap.className='caption';cap.textContent=s.name+' / '+kind;const a=document.createElement('a');a.className='living lk-'+kind;a.href='/p/'+kind+'/example';d.append(cap,a);m.append(d)}}, {surfaces,kinds:PAGE_KINDS})
  const geometry=await page.locator('.measure').evaluateAll(es=>es.map(e=>({name:e.dataset.name,kind:e.dataset.kind,y:e.getBoundingClientRect().y})))
  const png=await page.screenshot({path:path.join(out,theme+'-'+width+'-matrix.png'),fullPage:true})
  const samples=await page.evaluate(async({png,geometry,width})=>{const bytes=Uint8Array.from(atob(png),c=>c.charCodeAt(0));const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const c=canvas.getContext('2d');c.drawImage(bitmap,0,0);const pixel=(x,y)=>[...c.getImageData(x,y,1,1).data].slice(0,3).map(v=>v/255);return geometry.map(r=>({...r,background:Array.from({length:21},(_,i)=>pixel(Math.round(5+(width-11)*i/20),r.y+25)),foreground:Array.from({length:21},(_,i)=>pixel(Math.round(5+(width-11)*i/20),r.y+40))}))},{png:png.toString('base64'),geometry,width})
  for(const s of samples)rows.push({theme,width,surface:s.name,kind:s.kind,min:Math.min(...s.background.flatMap(b=>s.foreground.map(f=>contrast(b,f))))})
  // A readable companion screenshot, using exactly the same CSS and contexts.
  await page.addStyleTag({content:'.measure a{font-size:14px;top:28px;background-clip:text!important;-webkit-background-clip:text!important}.measure{height:60px!important} '})
  await page.locator('.measure a').evaluateAll(es=>es.forEach(e=>e.textContent=e.className.split('lk-')[1]+' result'))
  await page.screenshot({path:path.join(out,theme+'-'+width+'-links.png'),fullPage:true})
  await page.close()
 }
} finally { await browser.close() }
fs.writeFileSync(path.join(out,'contrast.json'),JSON.stringify({at:new Date().toISOString(),source:'rendered application CSS, raster samples before text antialiasing',rows},null,2))
for(const theme of ['light','graphite','dark','zen']){const rs=rows.filter(r=>r.theme===theme);console.log(theme,Math.min(...rs.map(r=>r.min)).toFixed(2),JSON.stringify(rs.sort((a,b)=>a.min-b.min).slice(0,3)))}
if(rows.some(r=>r.min<4.5))process.exitCode=1
