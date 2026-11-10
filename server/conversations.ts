// Conversations ChatGPT / Claude.ai : import des exports officiels, stockage SQLite, rangement par projet.

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ConversationDetail, ConversationSummary, Message } from '../shared/api.ts'
import { tr } from './i18n.ts'
import M from './i18n/conversations.ts'

interface ParsedConversation {
  id: string
  source: 'chatgpt' | 'claude'
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
}

const toMs = (v: unknown): number => {
  if (typeof v === 'number') return v < 1e12 ? Math.round(v * 1000) : v
  if (typeof v === 'string') return Date.parse(v) || 0
  return 0
}

// ---------------------------------------------------------------- formats d'export

/** ChatGPT : conversations.json, chaque conversation est un arbre (mapping) ; on suit la branche affichée. */
function parseChatGPT(c: any): ParsedConversation | null {
  const mapping = c.mapping ?? {}
  let node: string | undefined = c.current_node
  const out: Message[] = []
  const guard = new Set<string>()
  while (node && mapping[node] && !guard.has(node)) {
    guard.add(node)
    const m = mapping[node].message
    const role = m?.author?.role
    if (m && (role === 'user' || role === 'assistant')) {
      const parts = (m.content?.parts ?? []).filter((p: unknown) => typeof p === 'string') as string[]
      const text = (parts.join('\n') || (typeof m.content?.text === 'string' ? m.content.text : '')).trim()
      if (text && !m.metadata?.is_visually_hidden_from_conversation) {
        out.push({ id: m.id ?? node, role: role === 'user' ? 'user' : 'assistant', text, at: toMs(m.create_time) })
      }
    }
    node = mapping[node].parent
  }
  out.reverse()
  const id = c.conversation_id ?? c.id
  if (!id || !out.length) return null
  return { id: `gpt-${id}`, source: 'chatgpt', title: c.title || out[0].text.slice(0, 60), createdAt: toMs(c.create_time), updatedAt: toMs(c.update_time) || toMs(c.create_time), messages: out }
}

/** Claude.ai : conversations.json, liste plate chat_messages (sender human / assistant). */
function parseClaude(c: any): ParsedConversation | null {
  const msgs: Message[] = (c.chat_messages ?? [])
    .map((m: any, i: number) => {
      const text = (
        Array.isArray(m.content) && m.content.length
          ? m.content
              .filter((x: any) => x?.type === 'text')
              .map((x: any) => x.text)
              .join('\n')
          : (m.text ?? '')
      ).trim()
      return { id: m.uuid ?? `${c.uuid}-${i}`, role: m.sender === 'human' ? 'user' : 'assistant', text, at: toMs(m.created_at) } as Message
    })
    .filter((m: Message) => m.text)
  if (!c.uuid || !msgs.length) return null
  return { id: `claude-${c.uuid}`, source: 'claude', title: c.name || msgs[0].text.slice(0, 60), createdAt: toMs(c.created_at), updatedAt: toMs(c.updated_at) || toMs(c.created_at), messages: msgs }
}

export function parseExport(json: unknown): ParsedConversation[] {
  const list = Array.isArray(json) ? json : Array.isArray((json as any)?.conversations) ? (json as any).conversations : []
  const out: ParsedConversation[] = []
  for (const c of list) {
    const p = c?.mapping ? parseChatGPT(c) : c?.chat_messages ? parseClaude(c) : null
    if (p) out.push(p)
  }
  return out
}

/** Lit conversations.json depuis un zip d'export ou un fichier JSON brut. */
export async function readExportFile(file: string): Promise<unknown> {
  const head = Buffer.alloc(2)
  const fd = fs.openSync(file, 'r')
  fs.readSync(fd, head, 0, 2, 0)
  fs.closeSync(fd)
  if (head.toString() !== 'PK') return JSON.parse(fs.readFileSync(file, 'utf8'))
  const text = await new Promise<string>((resolve, reject) => {
    execFile('unzip', ['-p', file, 'conversations.json'], { maxBuffer: 1 << 29 }, (err, stdout) => (err ? reject(new Error(tr(M).noJsonInZip)) : resolve(stdout)))
  })
  return JSON.parse(text)
}

// ---------------------------------------------------------------- stockage

export class ConversationStore {
  db: DatabaseSync

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(path.join(dir, 'weevils.db'))
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, source TEXT, title TEXT, created_at INTEGER, updated_at INTEGER,
        message_count INTEGER, preview TEXT,
        project_id TEXT, status TEXT DEFAULT 'new', suggested_project_id TEXT, reason TEXT, confidence REAL, classified_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        conversation_id TEXT, idx INTEGER, role TEXT, text TEXT, at INTEGER,
        PRIMARY KEY (conversation_id, idx)
      );
      CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS corrections (conversation_id TEXT, title TEXT, project_id TEXT, at INTEGER);
      CREATE INDEX IF NOT EXISTS conv_project ON conversations(project_id);
      CREATE INDEX IF NOT EXISTS conv_status ON conversations(status);
    `)
  }

  /** Import idempotent : une conversation déjà connue est mise à jour seulement si elle a bougé. */
  import(list: ParsedConversation[]): { added: number; updated: number } {
    let added = 0
    let updated = 0
    const get = this.db.prepare('SELECT updated_at FROM conversations WHERE id = ?')
    const ins = this.db.prepare(
      'INSERT INTO conversations (id, source, title, created_at, updated_at, message_count, preview, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at, message_count = excluded.message_count, preview = excluded.preview',
    )
    const del = this.db.prepare('DELETE FROM messages WHERE conversation_id = ?')
    const msg = this.db.prepare('INSERT INTO messages (conversation_id, idx, role, text, at) VALUES (?, ?, ?, ?, ?)')
    this.db.exec('BEGIN')
    try {
      for (const c of list) {
        const prev = get.get(c.id) as { updated_at: number } | undefined
        if (prev && prev.updated_at >= c.updatedAt) continue
        const firstUser = c.messages.find((m) => m.role === 'user')?.text ?? c.messages[0].text
        ins.run(c.id, c.source, c.title.slice(0, 200), c.createdAt, c.updatedAt, c.messages.length, firstUser.replace(/\s+/g, ' ').slice(0, 280), 'new')
        del.run(c.id)
        c.messages.forEach((m, i) => msg.run(c.id, i, m.role, m.text.slice(0, 60_000), m.at || c.updatedAt))
        if (prev) updated++
        else added++
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return { added, updated }
  }

  private toSummary(r: any): ConversationSummary {
    return {
      id: r.id,
      source: r.source,
      title: r.title,
      projectId: r.project_id ?? null,
      updatedAt: r.updated_at,
      messageCount: r.message_count,
      preview: r.preview,
      status: r.status,
      suggestedProjectId: r.suggested_project_id ?? undefined,
      reason: r.reason ?? undefined,
      confidence: r.confidence ?? undefined,
    }
  }

  /** Pour l'instantané : tout ce qui est à ranger + les plus récentes. */
  summaries(limit = 300): ConversationSummary[] {
    const rows = this.db
      .prepare(`SELECT * FROM conversations WHERE status = 'pending' UNION SELECT * FROM (SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?) ORDER BY updated_at DESC`)
      .all(limit)
    return rows.map((r) => this.toSummary(r))
  }

  byProject(projectId: string): ConversationSummary[] {
    return this.db
      .prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC LIMIT 500')
      .all(projectId)
      .map((r) => this.toSummary(r))
  }

  search(q: string): ConversationSummary[] {
    const like = `%${q.replace(/[%_]/g, '')}%`
    return this.db
      .prepare('SELECT * FROM conversations WHERE title LIKE ? OR preview LIKE ? ORDER BY updated_at DESC LIMIT 100')
      .all(like, like)
      .map((r) => this.toSummary(r))
  }

  detail(id: string): ConversationDetail | undefined {
    const r = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id)
    if (!r) return undefined
    const messages = this.db
      .prepare('SELECT idx, role, text, at FROM messages WHERE conversation_id = ? ORDER BY idx')
      .all(id)
      .map((m: any) => ({ id: `${id}-${m.idx}`, role: m.role, text: m.text, at: m.at }) as Message)
    return { conversation: this.toSummary(r), messages }
  }

  counts(): { total: number; pending: number; byProject: Record<string, number> } {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n
    const pending = (this.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE status = 'pending'").get() as { n: number }).n
    const byProject: Record<string, number> = {}
    for (const r of this.db.prepare('SELECT project_id, COUNT(*) AS n FROM conversations WHERE project_id IS NOT NULL GROUP BY project_id').all() as { project_id: string; n: number }[])
      byProject[r.project_id] = r.n
    return { total, pending, byProject }
  }

  /** À classer : les nouvelles, les plus récentes d'abord. */
  unclassified(limit: number): { id: string; title: string; preview: string; updatedAt: number }[] {
    return this.db
      .prepare("SELECT id, title, preview, updated_at AS updatedAt FROM conversations WHERE status = 'new' ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as { id: string; title: string; preview: string; updatedAt: number }[]
  }

  /** De quoi parle vraiment la conversation : les premiers messages de l'utilisateur et les derniers échanges, compactés. */
  excerpt(id: string, budget = 1400): string {
    const rows = this.db.prepare('SELECT role, text FROM messages WHERE conversation_id = ? ORDER BY idx').all(id) as { role: string; text: string }[]
    const one = (t: string, n: number) => t.replace(/\s+/g, ' ').trim().slice(0, n)
    const t = tr(M)
    const head = rows.filter((m) => m.role === 'user').slice(0, 3).map((m) => t.said(t.me, one(m.text, 260)))
    const tail = rows.slice(-2).map((m) => t.said(m.role === 'user' ? t.me : t.ai, one(m.text, 220)))
    return [...head, rows.length > 5 ? '…' : '', ...tail].filter(Boolean).join('\n').slice(0, budget)
  }

  /**
   * Les catégories sont les projets, un thème n'est pas un projet : tout ce qui avait été rangé dans une catégorie
   * inventée (« cash », « design »…) repasse à classer, les catégories et les exemples qui les visaient disparaissent.
   */
  dropInventedCategories(): number {
    const n = (this.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE project_id LIKE 'cat-%' OR suggested_project_id LIKE 'cat-%'").get() as { n: number }).n
    this.db.exec(`
      UPDATE conversations SET project_id = NULL, suggested_project_id = NULL, status = 'new', reason = NULL, confidence = NULL
        WHERE project_id LIKE 'cat-%' OR suggested_project_id LIKE 'cat-%';
      DELETE FROM corrections WHERE project_id LIKE 'cat-%';
      DELETE FROM categories;
    `)
    return n
  }

  setClassification(id: string, c: { projectId: string | null; status: 'auto' | 'pending' | 'accepted' | 'corrected' | 'none'; suggested?: string | null; reason?: string; confidence?: number }) {
    this.db
      .prepare('UPDATE conversations SET project_id = ?, status = ?, suggested_project_id = ?, reason = ?, confidence = ?, classified_at = ? WHERE id = ?')
      .run(c.projectId, c.status, c.suggested ?? null, c.reason ?? null, c.confidence ?? null, Date.now(), id)
  }

  /** Choix de l'utilisateur : il devient un exemple pour les prochains classements. */
  correct(id: string, projectId: string) {
    const r = this.db.prepare('SELECT title, suggested_project_id, status FROM conversations WHERE id = ?').get(id) as { title: string; suggested_project_id: string | null; status: string } | undefined
    if (!r) throw new Error(tr(M).notFound)
    const status = r.status === 'pending' && r.suggested_project_id === projectId ? 'accepted' : 'corrected'
    this.db.prepare('UPDATE conversations SET project_id = ?, status = ?, classified_at = ? WHERE id = ?').run(projectId, status, Date.now(), id)
    this.db.prepare('INSERT INTO corrections (conversation_id, title, project_id, at) VALUES (?, ?, ?, ?)').run(id, r.title, projectId, Date.now())
  }

  corrections(limit = 20): { title: string; projectId: string }[] {
    return this.db.prepare('SELECT title, project_id AS projectId FROM corrections ORDER BY at DESC LIMIT ?').all(limit) as { title: string; projectId: string }[]
  }

  categories(): { id: string; name: string }[] {
    return this.db.prepare('SELECT id, name FROM categories ORDER BY name').all() as { id: string; name: string }[]
  }

  ensureCategory(name: string): string {
    const slug = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30)
    const id = `cat-${slug || crypto.randomBytes(3).toString('hex')}`
    this.db.prepare('INSERT OR IGNORE INTO categories (id, name, created_at) VALUES (?, ?, ?)').run(id, name.slice(0, 40).toLowerCase(), Date.now())
    return id
  }
}
