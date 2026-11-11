import fs from 'node:fs'
import { createServer } from 'vite'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
try {
 const { WeevbossLogo } = await vite.ssrLoadModule('/src/ui/logo.tsx')
 const escape = s => s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')
 const frames = ['light','dark','zen','graphite'].map(theme => {
  const home = renderToStaticMarkup(React.createElement(WeevbossLogo,{className:'voice-svg',title:'weevboss'}),{identifierPrefix:theme+'-home-'})
  const session = renderToStaticMarkup(React.createElement(WeevbossLogo,{className:'voice-svg',title:'weevboss'}),{identifierPrefix:theme+'-session-'})
  const recording = renderToStaticMarkup(React.createElement(WeevbossLogo,{className:'voice-svg',title:'Recording',recording:true}),{identifierPrefix:theme+'-recording-'})
  const html = `<!doctype html><html lang="en" data-theme="${theme}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{height:auto;overflow:auto;background:var(--agent)}.preview{padding:18px;color:var(--ink)}.preview h2{font:600 14px system-ui;margin:12px 0}.preview .agent-top{padding:0 0 8px}.preview .agent-nav{padding-bottom:18px;border-bottom:1px solid currentColor;font-size:18px;font-weight:700}.preview-session{margin-top:12px}.preview-session .session-header-row{justify-content:space-between}.preview .voice-logo{pointer-events:none}</style><body><main class="preview"><h2>Home</h2><div class="agent-top"><div class="voice"><button class="voice-logo" aria-label="Voice">${home}</button></div></div><div class="agent-nav">weevboss · <strong>for you</strong></div><div class="preview-session session-page"><h2>Session</h2><div class="session-header-row"><span>‹ Project</span><span>Model · effort</span><div class="session-header-voice"><button class="voice-logo" aria-label="Voice">${session}</button></div></div></div><h2>Recording colour</h2><button class="voice-logo rec" aria-label="Recording colour preview">${recording}</button></main></body></html>`
  return `<section><h2>${theme}</h2><iframe title="${theme} logo preview" srcdoc="${escape(html)}"></iframe></section>`
 }).join('')
 fs.writeFileSync('public/logo-preview.html',`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>weevboss — logo colours</title><style>body{margin:0;padding:24px;background:#eee;color:#171717;font:16px system-ui}h1{font-size:24px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:20px}h2{text-transform:capitalize;font-size:18px}iframe{display:block;width:100%;height:390px;border:0}p{max-width:65ch}</style><h1>One logo, four themes</h1><p>The same transparent mark, with colours adapted to each theme. Home and session controls keep fixed proportions.</p><main>${frames}</main><script>
fetch('/',{cache:'no-store'}).then(r=>r.text()).then(text=>{
 const doc=new DOMParser().parseFromString(text,'text/html');
 const href=doc.querySelector('link[rel="stylesheet"]')?.getAttribute('href');
 if(!href)return;
 for(const frame of document.querySelectorAll('iframe')){
  const apply=()=>{const link=document.createElement('link');link.rel='stylesheet';link.href=href;frame.contentDocument.head.prepend(link)};
  frame.addEventListener('load',apply,{once:true});
  if(frame.contentDocument?.readyState==='complete')apply();
 }
});
</script></html>`)
} finally { await vite.close() }
