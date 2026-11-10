import { noticeKey } from '../../shared/notices.ts'
import { Notice } from './notice'
import { useEffect, useState } from 'react'
import type { SessionSettings, Tool } from '../../shared/api.ts'
import { tr, useT } from '../i18n'
import M from '../i18n/settings'
import { Line } from './bits'
import { VoicePicker } from './voice'

/** Réglages manuels d'une session : ils partent en commandes slash (/model, /effort, /fast, /compact, /clear, /approvals). */

const MODELS: Record<Tool, string[]> = { claude: ['fable', 'opus', 'sonnet', 'haiku'], codex: [] }
const EFFORTS = ['low', 'medium', 'high', 'max']
/** Effort dans la langue de l'app (« effort élevé », « high effort ») : lu à l'appel. */
export const effortLabel = (e?: string) => (e ? tr(M).effortLabel(e) : undefined)

/** Le modèle avec sa version exacte, pour l'en-tête : « claude-fable-5-1 » → « fable 5.1 », « claude-sonnet-5 » →
 * « sonnet 5 », « claude-3-5-sonnet-20241022 » → « sonnet 3.5 » ; un modèle codex (gpt-…) ou inconnu tel quel. */
export function modelLabel(model?: string): string | undefined {
  if (!model) return undefined
  const id = model.replace(/\[[^\]]*\]$/, '').toLowerCase()
  const fam = /(opus|sonnet|haiku|fable)/.exec(id)?.[1]
  if (!id.startsWith('claude') || !fam) return model
  const nums = id.replace(/-\d{8}$/, '').match(/(?<=-)\d{1,2}(?=-|$)/g) ?? []
  return nums.length ? `${fam} ${nums.slice(0, 2).join('.')}` : fam
}

/** « claude-opus-4-1 » → « opus » (le sélecteur) ; un modèle codex est gardé tel quel. */
export function shortModel(model?: string): string | undefined {
  if (!model) return undefined
  const m = /opus|sonnet|haiku|fable/i.exec(model)
  return m ? m[0].toLowerCase() : model
}

interface Local {
  model?: string
  effort?: string
  fast?: boolean
  /** Moment du dernier choix fait d'ici : il prime le temps que la session le reflète. */
  at?: number
}
const KEY = (id: string) => `weevils-settings:${id}`
const load = (id: string): Local => {
  try {
    return JSON.parse(localStorage.getItem(KEY(id)) ?? '{}') as Local
  } catch {
    return {}
  }
}

/** Ce que l'app a réglé elle-même (effort et mode rapide ne se lisent pas dans le transcript) : mémorisé par session. */
export function useLocalSettings(id: string) {
  const [local, setLocal] = useState<Local>(() => load(id))
  useEffect(() => setLocal(load(id)), [id])
  const update = (patch: Local) =>
    setLocal((s) => {
      const next = { ...s, ...patch }
      try {
        localStorage.setItem(KEY(id), JSON.stringify(next))
      } catch {
        /* stockage indisponible */
      }
      return next
    })
  return [local, update] as const
}

function Choice({ label, options, value, onPick, words }: { label: string; options: string[]; value?: string; onPick: (v: string) => void; known: boolean; words?: (o: string) => string }) {
  return (
    <div className="in words" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o} className={`word ${value === o ? 'on' : ''}`} aria-pressed={value === o} onClick={() => onPick(o)}>
          {words ? words(o) : o}
        </button>
      ))}
    </div>
  )
}

export function Settings({
  id,
  tool,
  settings,
  canCommand,
  run,
  onPicker,
  userName,
}: {
  id: string
  tool: Tool
  settings?: SessionSettings
  /** La session tourne dans une pane weevils : on peut lui taper des commandes. */
  canCommand: boolean
  run: (command: string) => Promise<unknown>
  userName?: string
  /** Codex ouvre un menu dans le terminal (/model, /approvals) : montrer l'écran pour choisir avec les touches. */
  onPicker?: () => void
}) {
  const t = useT(M)
  const [local, setLocal] = useLocalSettings(id)
  const [err, setErr] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // Jamais bloquant : le choix s'affiche tout de suite, la commande part en fond.
  const send = (command: string, after?: () => void) => {
    setErr(null)
    after?.()
    setBusy(command)
    void run(command)
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(null))
  }

  const model = local.model && local.at && Date.now() - local.at < 20_000 ? local.model : (shortModel(settings?.model) ?? local.model)
  const modelKnown = !!settings?.model
  const models = model && !MODELS.claude.includes(model) ? [model, ...MODELS.claude] : MODELS.claude

  if (!canCommand) {
    return <div className="in meta empty">{t.unavailable}</div>
  }

  return (
    <div className="settings">
      {id === '__main' && <VoicePicker userName={userName ?? ''} />}
      {err && (
        <Notice eventId={noticeKey('error:settings', location.pathname, location.hash, err)} className="in meta" role="alert">
          ! {err}
        </Notice>
      )}
      {tool === 'claude' ? (
        <>
          <Choice label={t.model} options={models} value={model} known={modelKnown} onPick={(m) => void send(`/model ${m}`, () => setLocal({ model: m, at: Date.now() }))} />
          <Choice label={t.effort} options={EFFORTS} value={local.effort && local.at && Date.now() - local.at < 20_000 ? local.effort : (settings?.effort ?? local.effort)} known={!!settings?.effort} words={t.effortWord} onPick={(e) => void send(`/effort ${e}`, () => setLocal({ effort: e, at: Date.now() }))} />
          <div className="in settings-row">
            <span className="meta settings-label">
              {t.fastMode}
              {local.fast != null && <span className="settings-hint">{t.setHere}</span>}
            </span>
            <div className="words" role="group" aria-label={t.fastMode}>
              <button className={`word ${local.fast ? 'on' : ''}`} aria-pressed={!!local.fast} onClick={() => void send('/fast', () => setLocal({ fast: !local.fast }))}>
                {local.fast == null ? t.toggle : local.fast ? t.on : t.off}
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="in settings-row">
            <span className="meta settings-label">{t.model}{settings?.model ? ` · ${settings.model}` : ''}</span>
            <div className="words">
              <button className="word" onClick={() => void send('/model', onPicker)}>
                {'/model'}
              </button>
            </div>
          </div>
          <div className="in settings-row">
            <span className="meta settings-label">{t.approvals}{settings?.approval ? ` · ${settings.approval}` : ''}</span>
            <div className="words">
              <button className="word" onClick={() => void send('/approvals', onPicker)}>
                {'/approvals'}
              </button>
            </div>
          </div>
        </>
      )}
      <Line ch="⇣" go={null} onClick={() => void send('/compact')} disabled={busy === '/compact'}>
        {'/compact'}
      </Line>
      {confirm ? (
        <Line ch="!" go={null} className="invert" onClick={() => void send(tool === 'codex' ? '/new' : '/clear', () => setConfirm(null))}>
          {t.confirm} {tool === 'codex' ? '/new' : '/clear'}
        </Line>
      ) : (
        <Line ch="×" go={null} onClick={() => setConfirm('clear')}>
          {tool === 'codex' ? '/new' : '/clear'}
        </Line>
      )}
      {confirm && (
        <Line ch=" " go={null} onClick={() => setConfirm(null)}>
          <span className="meta">{t.cancel}</span>
        </Line>
      )}
    </div>
  )
}
