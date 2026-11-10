// Envoi SMTP minimal pour le pont e-mail : TLS direct (port 465), AUTH PLAIN, un destinataire. Aucune dépendance.
import tls from 'node:tls'

/** Envoie `data` (message complet, CRLF) de `from` à `to`. Rejette avec la réponse du serveur en cas de refus. */
export function smtpSend(o: { host: string; port: number; user: string; pass: string; from: string; to: string; data: string }, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: o.host, port: o.port, servername: o.host })
    let buf = ''
    let waiter: ((code: number, text: string) => void) | null = null
    // i18n-ignore : erreur de protocole, seulement journalisée
    const timer = setTimeout(() => fail(new Error('SMTP: timed out')), timeoutMs)
    const fail = (e: Error) => {
      clearTimeout(timer)
      sock.destroy()
      reject(e)
    }
    sock.on('error', fail)
    sock.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      // Une réponse se termine par une ligne « 250 texte » (les lignes « 250-… » la précèdent).
      const m = /(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/.exec(buf)
      if (!m || !waiter) return
      const w = waiter
      const text = buf
      waiter = null
      buf = ''
      w(Number(m[1]), text.trim())
    })
    const expect = (ok: number[], line?: string) =>
      new Promise<void>((res, rej) => {
        // i18n-ignore : erreur de protocole, seulement journalisée
        waiter = (code, text) => (ok.includes(code) ? res() : rej(new Error(`SMTP ${code}: ${text.slice(0, 200)}`)))
        if (line !== undefined) sock.write(`${line}\r\n`)
      })
    const stuffed = o.data.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
    ;(async () => {
      await expect([220])
      await expect([250], `EHLO ${o.from.split('@')[1] ?? 'weevils'}`)
      await expect([235], `AUTH PLAIN ${Buffer.from(`\0${o.user}\0${o.pass}`).toString('base64')}`)
      await expect([250], `MAIL FROM:<${o.from}>`)
      await expect([250, 251], `RCPT TO:<${o.to}>`)
      await expect([354], 'DATA')
      await expect([250], `${stuffed}\r\n.`)
      sock.write('QUIT\r\n')
      clearTimeout(timer)
      sock.end()
      resolve()
    })().catch(fail)
  })
}
