/** Public web destinations only. Protected app routes stay behind their existing
 * authenticated viewer instead of becoming shareable feed links. */
export function publicWebUrl(value: string): string | undefined {
  if (/\s|[\u0000-\u001f\u007f]/u.test(value)) return undefined
  try {
    const u = new URL(value)
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return undefined
    const host = u.hostname.toLowerCase().replace(/\.$/, '')
    if (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|invalid)$/u.test(host)) return undefined
    if (/^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u.test(host)) return undefined
    // IPv6 literals require explicit deployment support, never a guessed phone URL.
    if (host.startsWith('[')) return undefined
    if (/\/api\/(?:site|auth|login)(?:\/|$)/iu.test(u.pathname)) return undefined
    const privateKey = /^(?:k|key|token|access[_-]?token|auth|authorization|password|passwd|secret|signature|sig|code|session|jwt|x-amz-.+|x-goog-.+)$/iu
    if ([...u.searchParams.keys()].some(k => privateKey.test(k))) return undefined
    if (/(?:^#|[?&])(?:k|key|token|auth|code|secret|access_token)=/iu.test(u.hash)) return undefined
    return u.href
  } catch { return undefined }
}

/** No HTML interpretation; offsets let React retain plain text and escape labels. */
export function webLinks(text: string): { start: number; end: number; text: string; url?: string }[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"'`\]]+/giu)].map(match => {
    let value = match[0].replace(/[.,;:!?]+$/u, '')
    while (value.endsWith(')') && (value.match(/\)/g)?.length ?? 0) > (value.match(/\(/g)?.length ?? 0)) value = value.slice(0, -1)
    return { start: match.index!, end: match.index! + value.length, text: value, url: publicWebUrl(value) }
  })
}
