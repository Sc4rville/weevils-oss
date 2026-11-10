import { useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import type { GithubRepo } from '../../shared/api.ts'
import { api } from '../api'
import { useT } from '../i18n'
import M from '../i18n/repos'
import { useApp } from './app-context'
import { Shell } from './shell'
import { Icon } from './icons'
import { useViewHint } from './hints'
import { device } from './setup'

/** Couleur par position : un pas de 7 sur les 16 teintes, donc deux rectangles voisins (à côté ou dessous) n'ont jamais une teinte proche. */
const tint = (i: number) => ({ '--c': `var(--p${(i * 7) % 16})` }) as CSSProperties

export function ReposPage() {
  const t = useT(M)
  const { snap, push, refresh } = useApp()
  const [repos, setRepos] = useState<GithubRepo[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)
  const pinned = new Set(snap.pinnedRepos)
  // Sans GitHub branché, la bulle renvoie vers weevboss, qui explique comment le brancher.
  // Sans GitHub : weevboss explique en haut, avec son bouton ; les questions ne s'ouvrent qu'au tap (on peut être juste
  // venu voir, en apprenant le geste).
  useViewHint('repos', undefined, snap.setup?.github === false && { variant: 'reposOff', onOff: () => void api.setupAsk('github', device()).catch(() => undefined) })

  // Les phrases s'écrivent en fond côté serveur : on relit tant qu'il en manque.
  useEffect(() => {
    let off = false
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () =>
      api
        .githubRepos()
        .then((r) => {
          if (off) return
          setRepos(r.repos)
          if (r.repos.some((x) => !x.blurb) && tries++ < 20) timer = setTimeout(load, 5000)
        })
        .catch((e) => !off && setErr((e as Error).message))
    void load()
    return () => {
      off = true
      clearTimeout(timer)
    }
  }, [])

  const pin = async (repo: string, on: boolean) => {
    setErr(null)
    try {
      await api.pinRepo(repo, on)
      refresh()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const create = async (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n || busy) return
    setBusy(true)
    setErr(null)
    try {
      await api.newRepo(n, desc.trim())
      setName('')
      setDesc('')
      setRepos((await api.githubRepos(true)).repos)
      refresh()
    } catch (e2) {
      setErr((e2 as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell slot="agent" kicker="weevils" title={t.title} meta={repos ? t.count(repos.length) : '…'}>
      {err && (
        <div className="band invert" role="alert">
          <div className="in meta" style={{ paddingBlock: 12 }}>
            ! {err}
          </div>
        </div>
      )}
      <form className="band tone" onSubmit={create}>
        <div className="in repo-new">
          <span className="prompt" aria-hidden>
            <Icon name="plus" />
          </span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.name} aria-label={t.nameLabel} autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={busy} />
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t.desc} aria-label={t.descLabel} enterKeyHint="done" disabled={busy} />
          <button type="submit" className="send" aria-label={t.create} disabled={!name.trim() || busy}>
            {busy ? <span className="spin"><Icon name="star" /></span> : <Icon name="arrow" />}
          </button>
        </div>
      </form>
      <div className="repo-grid">
        {repos?.map((r, i) => {
          const on = pinned.has(r.name)
          const open = () => push({ kind: 'files', projectId: r.name.split(/[-_.]/)[0].toLowerCase(), repo: r.name })
          return (
            <div key={r.name} className="repo" style={tint(i)}>
              <button className="repo-open" aria-label={r.name} onClick={open}>
                <span className="repo-name">{r.name}</span>
                {r.blurb && <span className="repo-blurb">{r.blurb}</span>}
              </button>
              <button className={`repo-pin ${on ? 'on' : ''}`} aria-label={on ? t.unpin(r.name) : t.pin(r.name)} aria-pressed={on} onClick={() => void pin(r.name, !on)}>
                <Icon name={on ? 'check' : 'plus'} />
              </button>
            </div>
          )
        })}
      </div>
    </Shell>
  )
}
