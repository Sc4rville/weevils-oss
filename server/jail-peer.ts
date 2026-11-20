// Who is calling on loopback? weevilsd trusts a request born on this machine (http.ts isLocal) without the access
// code. An automation's session runs in a bwrap jail with its own process namespace (optimizers.ts jailArgs): its
// loopback calls must not get that trust, or `curl 127.0.0.1:<port>/api/…` would read what the jail hides.
// Linux only: the peer's socket is found in /proc/net/tcp*, its process among /proc/*/fd, and its pid namespace
// compared with ours. Anything not found (another user's process, sshd's tunnel, macOS) is not jailed.
import fs from 'node:fs'
import type net from 'node:net'

const ownNs = (() => {
  try {
    return fs.readlinkSync('/proc/self/ns/pid')
  } catch {
    return null
  }
})()
const seen = new WeakMap<net.Socket, boolean>()

/** The client end of a loopback TCP connection (its port → the server's port): its socket inode and owner uid. */
function peerEntry(peerPort: number, serverPort: number, read: (f: string) => string): { inode: string; uid: number } | null {
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string
    try {
      text = read(f)
    } catch {
      continue
    }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/)
      if (c.length < 10) continue
      if (parseInt(c[1].split(':')[1], 16) === peerPort && parseInt(c[2].split(':')[1], 16) === serverPort && c[9] !== '0') return { inode: c[9], uid: Number(c[7]) }
    }
  }
  return null
}

function ownerOf(inode: string): number | null {
  const want = `socket:[${inode}]`
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    let fds: string[]
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === want) return Number(pid)
      } catch {
        /* closed meanwhile */
      }
    }
  }
  return null
}

/** True when the peer of this loopback connection runs inside another pid namespace (an automation's jail). */
export function jailedPeer(socket: net.Socket | undefined, read: (f: string) => string = (f) => fs.readFileSync(f, 'utf8')): boolean {
  if (!socket || process.platform !== 'linux' || !ownNs) return false
  const known = seen.get(socket)
  if (known !== undefined) return known
  let jailed = false
  const peer = socket.remotePort
  const local = socket.localPort
  if (peer && local) {
    const inode = peerEntry(peer, local, read)?.inode
    const pid = inode ? ownerOf(inode) : null
    if (pid) {
      try {
        jailed = fs.readlinkSync(`/proc/${pid}/ns/pid`) !== ownNs
      } catch {
        /* gone */
      }
    }
  }
  seen.set(socket, jailed)
  return jailed
}

/** The routes behind the CLI subcommands an automation may run (optimizers.ts AUTO_WEEVILS). */
const JAILED_ROUTES: [string, RegExp][] = [
  ['GET', /^\/api\/snapshot$/], // sessions, projects
  ['GET', /^\/api\/sessions\/[^/]+$/], // read
  ['GET', /^\/api\/boss\/asks$/], // asks
  ['POST', /^\/api\/sessions$/], // new
  ['POST', /^\/api\/sessions\/[^/]+\/send$/], // send
  ['POST', /^\/api\/foryou\/(post|media|composition|visual-proposal)$/], // post, show
  ['GET', /^\/api\/pages$/], // pages
  ['POST', /^\/api\/pages$/], // page
  ['DELETE', /^\/api\/pages\/[^/]+$/], // page rm
]
export const jailedAllowed = (method: string | undefined, pathname: string) => JAILED_ROUTES.some(([m, re]) => m === method && re.test(pathname))

/** False when the peer of this loopback connection is another user's process (Linux; elsewhere always true). */
export function sameUserPeer(socket: net.Socket | undefined, read: (f: string) => string = (f) => fs.readFileSync(f, 'utf8')): boolean {
  if (!socket || process.platform !== 'linux' || !socket.remotePort || !socket.localPort) return true
  const e = peerEntry(socket.remotePort, socket.localPort, read)
  return !e || e.uid === process.getuid?.()
}
