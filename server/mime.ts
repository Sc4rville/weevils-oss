// E-mail, juste ce qu'il faut au pont : lire un message brut (en-têtes, texte, multipart, encodages) et en écrire un.
// Aucune dépendance. Le brut est manipulé en latin1 (un octet = un caractère) puis décodé dans son jeu de caractères.

export interface Mail {
  headers: Map<string, string[]>
  /** Premier en-tête de ce nom, déplié et décodé (RFC 2047). */
  get(name: string): string | undefined
  /** Tous les en-têtes de ce nom, dans l'ordre du message (le plus haut = le plus récent ajouté en route). */
  all(name: string): string[]
  messageId?: string
  inReplyTo?: string
  references: string[]
  subject: string
  /** Adresse de l'expéditeur (From), en minuscules. */
  from?: string
  fromName?: string
  /** Corps en texte (text/plain, sinon HTML débarrassé de ses balises). */
  text: string
}

const decoderFor = (charset: string | undefined) => {
  try {
    return new TextDecoder((charset || 'utf-8').trim().toLowerCase().replace(/^us-ascii$/, 'utf-8'))
  } catch {
    return new TextDecoder('utf-8')
  }
}
const bytes = (latin1: string) => Buffer.from(latin1, 'latin1')

/** Quoted-printable → octets (en latin1). */
export function decodeQP(s: string): string {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

/** Mots encodés des en-têtes : =?utf-8?B?…?= / =?iso-8859-1?Q?…?= */
export function decodeWords(s: string): string {
  return s
    .replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?)/gi, '$1')
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([bq])\?([^?]*)\?=/gi, (_, cs, enc, data) => {
      const raw = enc.toLowerCase() === 'b' ? Buffer.from(data, 'base64').toString('latin1') : decodeQP(data.replace(/_/g, ' '))
      return decoderFor(cs).decode(bytes(raw))
    })
}

function splitHead(raw: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(raw)
  return m ? { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) } : { head: raw, body: '' }
}

function parseHeaders(head: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const k = line.slice(0, i).trim().toLowerCase()
    out.set(k, [...(out.get(k) ?? []), line.slice(i + 1).trim()])
  }
  return out
}

/** « text/plain; charset="utf-8"; boundary=x » → type et paramètres. */
export function parseParams(v: string | undefined): { value: string; params: Record<string, string> } {
  const parts = (v ?? '').split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/)
  const params: Record<string, string> = {}
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=')
    if (i > 0) params[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().replace(/^"|"$/g, '')
  }
  return { value: (parts[0] ?? '').trim().toLowerCase(), params }
}

const ids = (v: string | undefined) => (v ? [...v.matchAll(/<[^<>\s]+>/g)].map((m) => m[0]) : [])

/** Adresse et nom d'un en-tête From / To. */
export function parseAddress(v: string | undefined): { address?: string; name?: string } {
  if (!v) return {}
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(v)
  const address = (angle?.[1] ?? /[^\s<>"',;]+@[^\s<>"',;]+/.exec(v)?.[0])?.toLowerCase()
  const name = angle ? v.slice(0, angle.index).trim().replace(/^"|"$/g, '') || undefined : undefined
  return { address, name }
}

const htmlToText = (html: string) =>
  html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')

/** Le texte d'une partie (récursif pour multipart) : text/plain d'abord, sinon HTML. */
function bodyText(headers: Map<string, string[]>, body: string): { plain?: string; html?: string } {
  const ct = parseParams(headers.get('content-type')?.[0] ?? 'text/plain')
  const disposition = parseParams(headers.get('content-disposition')?.[0]).value
  if (ct.value.startsWith('multipart/') && ct.params.boundary) {
    const b = ct.params.boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const chunks = body.split(new RegExp(`\\r?\\n?--${b}(?:--)?[ \\t]*(?:\\r?\\n|$)`)).slice(1)
    const out: { plain?: string; html?: string } = {}
    for (const c of chunks) {
      if (!c.trim()) continue
      const { head, body: inner } = splitHead(c)
      const r = bodyText(parseHeaders(head), inner)
      out.plain ??= r.plain
      out.html ??= r.html
    }
    return out
  }
  if (disposition === 'attachment' || !ct.value.startsWith('text/')) return {}
  const cte = (headers.get('content-transfer-encoding')?.[0] ?? '').toLowerCase()
  const raw = cte === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('latin1') : cte === 'quoted-printable' ? decodeQP(body) : body
  const text = decoderFor(ct.params.charset).decode(bytes(raw))
  return ct.value === 'text/html' ? { html: text } : ct.value === 'text/plain' ? { plain: text } : {}
}

export function parseMail(raw: Buffer | string): Mail {
  const s = typeof raw === 'string' ? Buffer.from(raw, 'utf8').toString('latin1') : raw.toString('latin1')
  const { head, body } = splitHead(s)
  const headers = parseHeaders(head)
  const all = (name: string) => (headers.get(name.toLowerCase()) ?? []).map((v) => decodeWords(decoderFor('utf-8').decode(bytes(v))))
  const get = (name: string) => all(name)[0]
  const t = bodyText(headers, body)
  const from = parseAddress(get('from'))
  return {
    headers,
    get,
    all,
    messageId: ids(get('message-id'))[0],
    inReplyTo: ids(get('in-reply-to'))[0],
    references: ids(get('references')),
    subject: (get('subject') ?? '').trim(),
    from: from.address,
    fromName: from.name,
    text: (t.plain ?? (t.html ? htmlToText(t.html) : '')).replace(/\r\n/g, '\n'),
  }
}

/** Ce que la personne a écrit : sans la citation du message précédent ni la signature. */
export function stripQuoted(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    // « Le … a écrit : » / « On … wrote: » (parfois sur deux lignes), « -----Original Message----- », séparateur de signature.
    if (/^(le |on ).{0,200}(a écrit|wrote)\s*:\s*$/i.test(l) || (/^(le |on )/i.test(l) && /(a écrit|wrote)\s*:\s*$/i.test(lines[i + 1] ?? ''))) break
    if (/^-{2,}\s*(original message|message d'origine)/i.test(l) || l === '-- ') break
    if (/^>/.test(l)) continue
    out.push(l)
  }
  return out.join('\n').trim()
}

const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`)
const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, '$&\r\n')

/** Un e-mail texte prêt pour SMTP (CRLF), corps en base64 UTF-8. */
export function buildMail(o: {
  from: string
  fromName?: string
  to: string
  subject: string
  text: string
  messageId: string
  inReplyTo?: string
  references?: string[]
  extraHeaders?: Record<string, string>
}): string {
  const h: string[] = [
    `From: ${o.fromName ? `${encWord(o.fromName)} ` : ''}<${o.from}>`,
    `To: <${o.to}>`,
    `Subject: ${encWord(o.subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${o.messageId}`,
  ]
  if (o.inReplyTo) h.push(`In-Reply-To: ${o.inReplyTo}`)
  if (o.references?.length) h.push(`References: ${o.references.join(' ')}`)
  for (const [k, v] of Object.entries(o.extraHeaders ?? {})) h.push(`${k}: ${v}`)
  h.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64')
  return `${h.join('\r\n')}\r\n\r\n${wrap76(Buffer.from(o.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64'))}`
}
