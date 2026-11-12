// Deterministic exports of the shipped logo component; no redraw and no browser.
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Resvg } from '@resvg/resvg-js'
const png = fs.readFileSync('public/branding/weevboss-cutout.png')
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
try {
 const { WeevbossLogo } = await vite.ssrLoadModule('/src/ui/logo.tsx')
 const mark = renderToStaticMarkup(React.createElement(WeevbossLogo,{title:'weevils'}),{identifierPrefix:'official-'})
  .replace('href="/branding/weevboss-cutout.png"',`href="data:image/png;base64,${png.toString('base64')}"`)
  .replace('width="44" height="44"','width="1046" height="1046"')
 const lightFilter='<filter id="light" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="linear" slope=".46"/><feFuncG type="linear" slope=".46"/><feFuncB type="linear" slope=".46"/></feComponentTransfer></filter>'
 const transparent=`<svg xmlns="http://www.w3.org/2000/svg" width="1046" height="1046" viewBox="0 0 1046 1046"><title>weevils</title><defs>${lightFilter}</defs><g filter="url(#light)">${mark}</g></svg>`
 fs.writeFileSync('public/branding/weevboss.svg',transparent)
 const { Icon } = await vite.ssrLoadModule('/src/ui/icons.tsx')
 // Fixed app branding, using the existing light-theme purple and working green.
 const purple='#B39BFF', green='#1fd60a'
 const star = renderToStaticMarkup(React.createElement(Icon,{name:'star'}))
  .replace('<svg ', '<svg x="100" y="112" width="104" height="104" ')
  .replace('stroke="currentColor"',`stroke="${green}"`)
  .replace('class="ic-halo"','class="ic-halo" stroke="#000" stroke-width="4.5"')
 // The star slightly overlaps the upper-left body plane; both fit the maskable safe circle.
 const composition=`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><title>weevils app icon</title><defs>${lightFilter}</defs><rect width="512" height="512" fill="${purple}"/><g transform="translate(86 86) scale(${340/1046})" filter="url(#light)">${mark}</g>${star}</svg>`
 fs.writeFileSync('public/branding/app-icon.svg',composition)
 const files={}
 for(const size of [32,96,180,192,512]) {
  // Notification badges remain transparent silhouettes; installed icons share one composition.
  const image=size===96 ? `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs>${lightFilter}</defs><g transform="scale(${512/1046})" filter="url(#light)">${mark}</g></svg>` : composition
  const rendered=new Resvg(image,{fitTo:{mode:'width',value:size}}).render()
  const data=rendered.asPng(),name=size===32?'favicon-32.png':size===96?'badge-96.png':`icon-${size}.png`
  fs.writeFileSync(`public/${name}`,data)
  files[name]={width:rendered.width,height:rendered.height,sha256:createHash('sha256').update(data).digest('hex')}
 }
 const version=name=>files[name].sha256.slice(0,12)
 const html=fs.readFileSync('index.html','utf8').replace(/(<link id="app-favicon"[^>]+href=")[^"]+/,`$1/favicon-32.png?v=${version('favicon-32.png')}`).replace(/(rel="apple-touch-icon" href=")[^"]+/,`$1/icon-180.png?v=${version('icon-180.png')}`)
 fs.writeFileSync('index.html',html)
 const manifest=JSON.parse(fs.readFileSync('public/manifest.webmanifest','utf8'))
 for(const icon of manifest.icons){const name=icon.src.split('/').at(-1).split('?')[0];if(files[name])icon.src=`/${name}?v=${version(name)}`}
 fs.writeFileSync('public/manifest.webmanifest',JSON.stringify(manifest,null,2)+'\n')
 const sw=fs.readFileSync('public/sw.js','utf8').replaceAll(/\/icon-192\.png(?:\?v=[a-z0-9]+)?/g,`/icon-192.png?v=${version('icon-192.png')}`)
 fs.writeFileSync('public/sw.js',sw.replace(/badge: '[^']+'/g,`badge: '/badge-96.png?v=${version('badge-96.png')}'`))
 fs.writeFileSync('public/branding/exports.json' ,JSON.stringify({sourceSha256:createHash('sha256').update(png).digest('hex'),source:'weevboss-cutout.png',component:'src/ui/logo.tsx',appIcon:{source:'app-icon.svg',starComponent:'src/ui/icons.tsx#Icon(star)',purple,green,starBox:[100,112,104,104],maskableSafeRadius:0.4},files},null,2)+'\n')
 console.log('Official logo exports: transparent SVG, 32px favicon, 96px notification badge, 180/192/512px app icons')
} finally { await vite.close() }
