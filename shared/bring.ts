// Bring your conversations (server/bring.ts, src/ui/bring.tsx): the Claude Code and Codex conversations of another
// computer, listed here, brought over in one tap and resumed like any session.

import type { Tool } from './api.ts'

export interface BringItem {
  /** « claude:<id> » or « codex:<id> ». */
  key: string
  tool: Tool
  id: string
  title: string
  /** The folder's name on the other computer. */
  project: string
  /** Last written, ms. */
  at: number
  size: number
  /** moving: on its way; here: a session of this machine now (sessionId); failed: tap again. */
  state?: 'moving' | 'here' | 'failed'
  sessionId?: string
  /** « clone »: the repository could not be cloned here, the conversation sits in an empty folder of the same name. */
  note?: string
}

export interface BringSource {
  /** « pc:<code> » (a computer that ran the line) or « remote:<id> » (a machine connected to this weevils). */
  id: string
  name: string
  /** Still answering: a tap brings now. */
  live: boolean
  items: BringItem[]
}

export interface BringView {
  sources: BringSource[]
  /** A line was handed out and no computer has used it yet. */
  waiting: boolean
}
