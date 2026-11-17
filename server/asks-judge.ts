// A session's last words end on a « ? » or a request: is it a real question for the human? Only then does it show the
// question mark and a « reply » card, reworded as one clear sentence. Haiku decides; when in doubt (or unreachable): no.

import { haiku } from './fast.ts'
import { tr, user } from './i18n.ts'
import M from './i18n/asks.ts'

export interface AskInput {
  session: string
  where: string
  /** The end of the agent's last message. */
  message: string
  /** The sentence the local detector took for a question. */
  said: string
}

/** The question reworded as one sentence, or null: not a real question for the human. Throws when Haiku is unreachable. */
export async function judgeAsk(i: AskInput): Promise<string | null> {
  const out = await haiku(tr(M).prompt(user(), i.session, i.where, i.message.slice(-1500)), 45_000)
  const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as { real?: unknown; question?: unknown }
  const q = typeof j.question === 'string' ? j.question.replace(/\s+/g, ' ').trim() : ''
  return j.real === true && q ? q.slice(0, 200) : null
}
