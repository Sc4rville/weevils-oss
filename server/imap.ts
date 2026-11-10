// Client IMAP minimal pour le pont e-mail : TLS, LOGIN, SELECT, UID SEARCH / FETCH, IDLE. Aucune dépendance.
// Une réponse IMAP peut contenir des littéraux {n}\r\n<n octets> : on les découpe à part, en Buffer.
import { EventEmitter } from 'node:events'
import tls from 'node:tls'

export interface ImapUnit {
  /** La ligne, littéraux remplacés par « {n} ». */
  line: string
  literals: Buffer[]
}

interface Pending {
  tag: string
  untagged: ImapUnit[]
  resolve: (u: ImapUnit[]) => void
  reject: (e: Error) => void
  /** IDLE : la suite (« + idling ») arrive avant la fin. */
  onContinue?: () => void
}

const quote = (s: string) => `"${s.replace(/["\\]/g, '\\$&')}"`

/** Découpe ce qui est arrivé en réponses complètes ; renvoie les unités et le reste non terminé. */
export function splitUnits(buf: Buffer): { units: ImapUnit[]; rest: Buffer } {
  const units: ImapUnit[] = []
  let pos = 0
  for (;;) {
    let line = ''
    const literals: Buffer[] = []
    let p = pos
    let complete = false
    for (;;) {
      const nl = buf.indexOf('\r\n', p)
      if (nl < 0) break
      const part = buf.toString('latin1', p, nl)
      const lit = /\{(\d+)\+?\}$/.exec(part)
      if (!lit) {
        line += part
        p = nl + 2
        complete = true
        break
      }
      const n = Number(lit[1])
      if (buf.length < nl + 2 + n) break
      line += part
      literals.push(buf.subarray(nl + 2, nl + 2 + n))
      p = nl + 2 + n
    }
    if (!complete) break
    units.push({ line, literals })
    pos = p
  }
  return { units, rest: buf.subarray(pos) }
}

export class Imap extends EventEmitter {
  private sock?: tls.TLSSocket
  private buf: Buffer = Buffer.alloc(0)
  private n = 0
  private pending: Pending[] = []
  private host: string
  private port: number
  private user: string
  private pass: string
  closed = false

  constructor(o: { host: string; port: number; user: string; pass: string }) {
    super()
    this.host = o.host
    this.port = o.port
    this.user = o.user
    this.pass = o.pass
  }

  connect(timeoutMs = 20_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = tls.connect({ host: this.host, port: this.port, servername: this.host })
      this.sock = sock
      sock.setKeepAlive(true, 60_000)
      const timer = setTimeout(() => {
        // i18n-ignore : erreur de protocole, seulement journalisée
        reject(new Error('IMAP: connection timed out'))
        sock.destroy()
      }, timeoutMs)
      let greeted = false
      sock.on('data', (d: Buffer) => {
        this.buf = Buffer.concat([this.buf, d])
        const { units, rest } = splitUnits(this.buf)
        this.buf = rest
        for (const u of units) {
          if (!greeted) {
            greeted = true
            clearTimeout(timer)
            if (/^\* (OK|PREAUTH)/i.test(u.line)) resolve()
            // i18n-ignore : erreur de protocole, seulement journalisée
            else reject(new Error(`IMAP: unexpected greeting "${u.line.slice(0, 80)}"`))
            continue
          }
          this.onUnit(u)
        }
      })
      const end = (e?: Error) => {
        if (this.closed) return
        this.closed = true
        clearTimeout(timer)
        // i18n-ignore : erreur de protocole, seulement journalisée
        const err = e ?? new Error('IMAP: connection closed')
        for (const p of this.pending.splice(0)) p.reject(err)
        if (!greeted) reject(err)
        this.emit('close', err)
      }
      sock.on('error', end)
      sock.on('close', () => end())
    })
  }

  private onUnit(u: ImapUnit) {
    const cur = this.pending[0]
    if (u.line.startsWith('+')) return cur?.onContinue?.()
    if (u.line.startsWith('* ')) {
      // Nouveau message, même hors commande (IDLE) : le pont va voir.
      if (/^\* \d+ EXISTS/i.test(u.line)) this.emit('exists')
      if (/^\* BYE/i.test(u.line)) this.emit('bye', u.line)
      cur?.untagged.push(u)
      return
    }
    const p = this.pending.find((x) => u.line.startsWith(`${x.tag} `))
    if (!p) return
    this.pending.splice(this.pending.indexOf(p), 1)
    if (/^\S+ OK/i.test(u.line)) p.resolve(p.untagged)
    // i18n-ignore : erreur de protocole, seulement journalisée
    else p.reject(new Error(`IMAP: ${u.line.slice(p.tag.length + 1, p.tag.length + 200)}`))
  }

  /** Une commande ; résout avec ses réponses non étiquetées. Rien n'est journalisé ici (LOGIN contient le mot de passe). */
  cmd(command: string, timeoutMs = 60_000): Promise<ImapUnit[]> {
    // i18n-ignore : erreur de protocole, seulement journalisée
    if (this.closed || !this.sock) return Promise.reject(new Error('IMAP: not connected'))
    const tag = `W${++this.n}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // i18n-ignore : erreur de protocole, seulement journalisée
        reject(new Error(`IMAP: no answer to ${command.split(' ')[0]}`))
        this.close()
      }, timeoutMs)
      this.pending.push({
        tag,
        untagged: [],
        resolve: (u) => (clearTimeout(timer), resolve(u)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
      this.sock!.write(`${tag} ${command}\r\n`)
    })
  }

  login() {
    return this.cmd(`LOGIN ${quote(this.user)} ${quote(this.pass)}`)
  }

  /** SELECT : UIDVALIDITY et UIDNEXT de la boîte. */
  async select(box: string): Promise<{ uidValidity: number; uidNext: number }> {
    const u = await this.cmd(`SELECT ${quote(box)}`)
    const num = (re: RegExp) => Number(u.map((x) => re.exec(x.line)?.[1]).find(Boolean) ?? 0)
    return { uidValidity: num(/UIDVALIDITY (\d+)/i), uidNext: num(/UIDNEXT (\d+)/i) }
  }

  async uidsAfter(uid: number): Promise<number[]> {
    const u = await this.cmd(`UID SEARCH UID ${uid + 1}:*`)
    const line = u.find((x) => /^\* SEARCH/i.test(x.line))?.line ?? ''
    // « n:* » rend toujours au moins le dernier message, même s'il est avant n.
    return line.replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter(Boolean).map(Number).filter((n) => n > uid).sort((a, b) => a - b)
  }

  /** Le message brut (sans le marquer lu). */
  async fetch(uid: number): Promise<Buffer | null> {
    const u = await this.cmd(`UID FETCH ${uid} (UID BODY.PEEK[])`, 120_000)
    const hit = u.find((x) => /FETCH/i.test(x.line) && x.literals.length)
    return hit ? hit.literals[0] : null
  }

  markSeen(uid: number) {
    return this.cmd(`UID STORE ${uid} +FLAGS.SILENT (\\Seen)`)
  }

  /** IDLE jusqu'à `ms` ou jusqu'à un nouveau message, puis DONE. Résout à la fin de l'IDLE. */
  idle(ms: number): Promise<void> {
    // i18n-ignore : erreur de protocole, seulement journalisée
    if (this.closed || !this.sock) return Promise.reject(new Error('IMAP: not connected'))
    const tag = `W${++this.n}`
    return new Promise((resolve, reject) => {
      let done = false
      const finish = () => {
        if (done || this.closed) return
        done = true
        clearTimeout(timer)
        this.off('exists', finish)
        this.sock?.write('DONE\r\n')
      }
      const timer = setTimeout(finish, ms)
      this.once('exists', finish)
      const guard = setTimeout(() => {
        // i18n-ignore : erreur de protocole, seulement journalisée
        reject(new Error('IMAP: IDLE never ended'))
        this.close()
      }, ms + 60_000)
      this.pending.push({
        tag,
        untagged: [],
        resolve: () => (clearTimeout(guard), clearTimeout(timer), this.off('exists', finish), resolve()),
        reject: (e) => (clearTimeout(guard), clearTimeout(timer), this.off('exists', finish), reject(e)),
      })
      this.sock!.write(`${tag} IDLE\r\n`)
    })
  }

  close() {
    try {
      if (!this.closed) this.sock?.write('Z LOGOUT\r\n')
    } catch {
      /* déjà fermée */
    }
    this.sock?.destroy()
  }
}
