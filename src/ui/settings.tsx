import { ModelPicker } from './model-controls'
import { tr } from '../i18n'
import M from '../i18n/settings'
import { VoicePicker } from './voice'

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

/**
 * A conversation's settings: weevboss's voice, or the model and effort of a session, each applied in one tap by the
 * server (src/ui/model-controls.tsx). No slash command is typed from here; fast mode, « tidy up » and « start over » are
 * gone (Scarville, 2026-11-17: nothing that doesn't earn its place).
 */
export function Settings({ id, userName }: { id: string; userName?: string }) {
  return <div className="settings">{id === '__main' ? <VoicePicker userName={userName ?? ''} /> : <ModelPicker key={id} id={id} />}</div>
}
