import { useCallback, useEffect, useRef, useState } from 'react'

export const CAPTURE_OFFER_MS = 10_000
const fingerprint = async (blob: Blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].join(',')

/** A clipboard image is a proposal, never an attachment or an automatic send.
 * iOS has no web screenshot event; explicit paste always works when it carries an image.
 * Background reads are attempted only with an already-granted persistent permission. */
export function useCaptureSuggestion(enabled: boolean) {
  const [candidate, setCandidate] = useState<{ file: File; url: string; expires: number } | null>(null)
  const version = useRef(0)
  const last = useRef('')
  const offer = useCallback((file: File, knownHash?: string) => {
    if (!enabled || !file.type.startsWith('image/')) return
    const offered = ++version.current
    if (knownHash) last.current = knownHash
    else void fingerprint(file).then((hash) => {
      if (version.current === offered) last.current = hash
    }).catch(() => { /* Explicit paste still works without SubtleCrypto. */ })
    setCandidate({ file, url: URL.createObjectURL(file), expires: Date.now() + CAPTURE_OFFER_MS })
  }, [enabled])
  const clear = useCallback(() => { version.current++; setCandidate(null) }, [])
  useEffect(() => {
    if (!candidate) return
    const timer = setTimeout(clear, Math.max(0, candidate.expires - Date.now()))
    const expire = () => { if (Date.now() >= candidate.expires) clear() }
    window.addEventListener('focus', expire)
    document.addEventListener('visibilitychange', expire)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', expire)
      document.removeEventListener('visibilitychange', expire)
      URL.revokeObjectURL(candidate.url)
    }
  }, [candidate, clear])
  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let reading = false
    const read = async () => {
      if (reading || document.visibilityState === 'hidden' || !document.hasFocus()) return
      if (!navigator.clipboard?.read || !navigator.permissions?.query) return
      reading = true
      const before = version.current
      try {
        // Safari rejects this permission name: no prompt and no automatic read there.
        const permission = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName })
        if (permission.state !== 'granted') return
        const items = await navigator.clipboard.read()
        const item = items.find((i) => i.types.some((t) => t.startsWith('image/')))
        const type = item?.types.find((t) => t.startsWith('image/'))
        if (!item || !type) return
        const blob = await item.getType(type)
        const hash = await fingerprint(blob)
        if (stopped || version.current !== before || hash === last.current) return
        offer(new File([blob], 'clipboard.png', { type }), hash)
      } catch { /* Permission denied or API unavailable: the native + / explicit paste remains usable. */ }
      finally { reading = false }
    }
    window.addEventListener('focus', read)
    document.addEventListener('visibilitychange', read)
    navigator.clipboard?.addEventListener?.('clipboardchange', read)
    return () => {
      stopped = true
      window.removeEventListener('focus', read)
      document.removeEventListener('visibilitychange', read)
      navigator.clipboard?.removeEventListener?.('clipboardchange', read)
    }
  }, [enabled, offer])
  return { candidate: enabled ? candidate : null, offer, clear }
}
