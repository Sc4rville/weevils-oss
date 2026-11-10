/** Follow the visible viewport without losing the iOS status-bar inset when the keyboard opens. */
export function trackViewport() {
  const vv = window.visualViewport
  if (!vv) return
  const root = document.documentElement
  const probe = document.createElement('div')
  probe.style.paddingTop = 'env(safe-area-inset-top, 0px)'
  probe.style.position = 'fixed'
  probe.style.visibility = 'hidden'
  document.body.append(probe)
  let safeTop = 0
  const update = () => {
    safeTop = Math.max(safeTop, parseFloat(getComputedStyle(probe).paddingTop) || 0)
    root.style.setProperty('--safe-t', `${safeTop}px`)
    root.style.setProperty('--vvh', `${vv.height}px`)
    root.style.setProperty('--vvt', `${vv.offsetTop}px`)
    root.toggleAttribute('data-keyboard', window.innerHeight - vv.height > 150)
  }
  update()
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  // Safari may restore its viewport after focusout or a page-cache restore without
  // delivering another visualViewport event. Sample again after the keyboard animation.
  let settle: ReturnType<typeof setTimeout> | undefined
  const resample = () => {
    update()
    clearTimeout(settle)
    settle = setTimeout(update, 350)
  }
  window.addEventListener('resize', resample)
  window.addEventListener('pageshow', resample)
  document.addEventListener('focusout', resample)
  document.addEventListener('visibilitychange', resample)
  return () => {
    clearTimeout(settle)
    window.removeEventListener('resize', resample)
    window.removeEventListener('pageshow', resample)
    document.removeEventListener('focusout', resample)
    document.removeEventListener('visibilitychange', resample)
    vv.removeEventListener('resize', update)
    vv.removeEventListener('scroll', update)
    probe.remove()
    root.style.removeProperty('--safe-t')
    root.style.removeProperty('--vvh')
    root.style.removeProperty('--vvt')
    root.removeAttribute('data-keyboard')
  }
}
