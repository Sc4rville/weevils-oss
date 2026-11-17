// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import { WeevbossLogo } from '../src/ui/logo'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => document.documentElement.removeAttribute('data-theme'))
it('keeps the same cropped geometry and bounded box for all four themes with unique filter identities', async () => {
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try {
  await act(async()=>root.render(<><WeevbossLogo className="voice-svg" title="weevboss"/><WeevbossLogo className="tr-logo"/></>))
  const logo=host.querySelector('svg')!
  const image=logo.querySelector('image')!
  for(const theme of ['light','dark','zen','graphite']) {
   document.documentElement.dataset.theme=theme
   expect(host.querySelector('svg')).toBe(logo)
   expect(logo.getAttribute('viewBox')).toBe('106 126 1046 1046')
   expect(logo.getAttribute('width')).toBe('44')
   expect(logo.getAttribute('height')).toBe('44')
   expect(image.getAttribute('href')).toContain('weevboss-cutout.png')
   expect(logo.querySelectorAll('feComponentTransfer')).toHaveLength(1)
   expect(logo.querySelectorAll('feFlood')).toHaveLength(0)
  }
  expect(new Set([...host.querySelectorAll('filter')].map(el=>el.id)).size).toBe(2)
  expect(logo.getAttribute('aria-label')).toBe('weevboss')
  expect(host.querySelectorAll('svg')[1].getAttribute('aria-hidden')).toBe('true')
 }finally{await act(async()=>root.unmount());host.remove()}
})
it('bounds the voice control independently of viewport height and isolates each theme filter to the logo', () => {
 const css=fs.readFileSync('src/styles.css','utf8')
 const rule=css.match(/\.voice-logo \{([^}]+)\}/)![1]
 expect(rule).toContain('width: 56px')
 expect(rule).toContain('height: 56px')
 expect(rule).not.toContain('dvh')
 expect(css.match(/--logo-filter:/g)).toHaveLength(4)
 expect(css).toContain('filter: var(--logo-filter, none)')
 expect(css).toContain('.session-header-voice .voice-logo { width: 44px; height: 44px;')
})
