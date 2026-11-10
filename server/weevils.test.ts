import { describe, expect, it } from 'vitest'
import { ruleMatch } from './classify.ts'
import { parseExport } from './conversations.ts'
import { familyOf, place } from './projects.ts'
import { attentionFromScreen } from './mux.ts'
import { tr } from './i18n.ts'
import CM from './i18n/conversations.ts'
import CO from './i18n/core.ts'

// Exports miniatures aux formats officiels (structure seulement, contenu inventé pour le test).
const chatgpt = [
  {
    id: 'c1',
    title: 'Idée pour shop',
    create_time: 1_700_000_000.5,
    update_time: 1_700_000_100.5,
    current_node: 'n3',
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['n1'] },
      n1: { id: 'n1', parent: 'root', message: { id: 'm1', author: { role: 'system' }, content: { content_type: 'text', parts: [''] } } },
      n2: { id: 'n2', parent: 'n1', message: { id: 'm2', author: { role: 'user' }, content: { content_type: 'text', parts: ['On simplifie shop-demo ?'] }, create_time: 1_700_000_001 } },
      n2b: { id: 'n2b', parent: 'n1', message: { id: 'm2b', author: { role: 'user' }, content: { content_type: 'text', parts: ['branche abandonnée'] } } },
      n3: { id: 'n3', parent: 'n2', message: { id: 'm3', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Oui, en trois étapes.'] }, create_time: 1_700_000_002 } },
    },
  },
]
const claude = [
  {
    uuid: 'u1',
    name: 'Recette de crêpes',
    created_at: '2026-11-01T10:00:00Z',
    updated_at: '2026-11-01T10:05:00Z',
    chat_messages: [
      { uuid: 'a', sender: 'human', text: '', content: [{ type: 'text', text: 'Une recette rapide ?' }], created_at: '2026-11-01T10:00:00Z' },
      { uuid: 'b', sender: 'assistant', text: 'Farine, œufs, lait.', content: [], created_at: '2026-11-01T10:01:00Z' },
    ],
  },
]

describe('import des exports', () => {
  it('ChatGPT : suit la branche affichée, ignore système et branches abandonnées', () => {
    const [c] = parseExport(chatgpt)
    expect(c.id).toBe('gpt-c1')
    expect(c.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'On simplifie shop-demo ?'],
      ['assistant', 'Oui, en trois étapes.'],
    ])
    expect(c.updatedAt).toBe(1_700_000_100_500)
  })

  it('Claude.ai : messages à plat, contenu riche ou texte', () => {
    const [c] = parseExport(claude)
    expect(c.id).toBe('claude-u1')
    expect(c.messages.map((m) => m.text)).toEqual(['Une recette rapide ?', 'Farine, œufs, lait.'])
  })
})

describe('classement', () => {
  const catalog = [
    { id: 'shop', name: 'shop', repos: ['shop-demo', 'shop-oss'] },
    { id: 'arcade', name: 'arcade', repos: ['arcade', 'arcade-trailer'] },
  ]
  it('un nom de repo dans l’échange suffit, le plus précis gagne', () => {
    expect(ruleMatch('On simplifie shop-demo ?', catalog)?.id).toBe('shop')
    expect(ruleMatch('le trailer de arcade-trailer', catalog)?.id).toBe('arcade')
  })
  it('pas de faux positif sur un mot courant', () => {
    expect(ruleMatch('Une recette rapide ?', catalog)).toBeNull()
  })
})

describe('rangement des sessions', () => {
  it('dossier → repo → famille', () => {
    expect(familyOf('shop-audit-breaker-r0')).toBe('shop')
    expect(place('/home/me/projects/shop-demo/src', ['/home/me/projects']).projectId).toBe('shop')
    expect(place('/home/me/projects/.night/shop', ['/home/me/projects']).repo).toBe('shop')
    expect(place('/tmp', ['/home/me/projects']).projectId).toBe('divers')
    expect(place('/home/me/Documents/projects/jarvis', ['/home/me/projects', '/home/me/Documents/projects']).projectId).toBe('jarvis')
  })
})

describe('questions à l’écran', () => {
  it('Claude : confiance dans le dossier', () => {
    const screen = ' Quick safety check: Is this a project you created or one you trust? (Like your own code)\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel'
    expect(attentionFromScreen(screen)).toBe('Quick safety check: Is this a project you created or one you trust?')
  })
  it('Codex : menu numéroté', () => {
    expect(attentionFromScreen('  Trust this folder? Codex can read files.\n› 1. Trust and continue\n  enter continue · esc back')).toBe('Trust this folder?')
  })
  it('écran normal : rien', () => {
    expect(attentionFromScreen('› Ask Codex to do anything\n  ← for agents')).toBeUndefined()
  })
  it('un mot de dialogue dans le fil normal ne suffit pas (faux « à toi » du 9 novembre)', () => {
    const screen = [
      '● Bash(cat ~/.local/bin/wv)',
      '  ⎿  else claude_flags=(--dangerously-skip-permissions); codex_flags=(--dangerously-bypass-approvals-and-sandbox); fi',
      '     … +5 lines (ctrl+o to expand)',
      '● Do you want me to allow the script to continue? Would you like a summary?',
      '',
      '╭──────────────────────────────────────────╮',
      '│ > essaie encore                          │',
      '╰──────────────────────────────────────────╯',
      '  ? for shortcuts',
    ].join('\n')
    expect(attentionFromScreen(screen)).toBeUndefined()
  })
  it('Claude : question à choix (AskUserQuestion)', () => {
    const screen = [
      '● Quelle couleur pour la bande ?',
      '',
      '  ❯ 1. Vert',
      '    2. Bleu',
      '    3. Autre',
      '',
      '  Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n')
    expect(attentionFromScreen(screen)).toBe('Quelle couleur pour la bande ?')
  })
  it('Claude : permission d’outil', () => {
    const screen = ['  Bash command', '  rm -rf dist', '  Do you want to proceed?', '  ❯ 1. Yes', '    2. No, and tell Claude what to do differently (esc)', '', '  Esc to cancel'].join('\n')
    expect(attentionFromScreen(screen)).toBe('Do you want to proceed?')
  })
})

describe('pièces jointes pour l’orchestrateur', async () => {
  const { saveInbox, withFiles } = await import('./core.ts')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  it('dépose <date>-<nom> dans le dossier et annonce « (fichier : /chemin) »', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-inbox-'))
    const saved = saveInbox(dir, [
      { name: 'devis final.pdf', type: 'application/pdf', data: Buffer.from('%PDF').toString('base64') },
      { name: 'IMG_1.heic', type: 'image/heic', data: Buffer.from('x').toString('base64') },
    ])
    expect(saved.map((s) => path.basename(s.path))).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}-devis-final\.pdf$/), expect.stringMatching(/-IMG_1\.heic$/)])
    expect(fs.readFileSync(saved[0].path, 'utf8')).toBe('%PDF')
    const msg = withFiles('range ça', saved)
    const t = tr(CO)
    expect(msg).toBe(`range ça ${t.attached(false, saved[0].path)} ${t.attached(true, saved[1].path)}`)
    expect(withFiles('', [saved[0]])).toBe(`${t.oneFile} ${t.attached(false, saved[0].path)}`)
    // Même nom une seconde fois : pas d'écrasement.
    const again = saveInbox(dir, [{ name: 'devis final.pdf', type: 'application/pdf', data: '' }])
    expect(again[0].path).not.toBe(saved[0].path)
    fs.rmSync(dir, { recursive: true })
  })
})

describe('commandes de réglage', async () => {
  const { checkCommand } = await import('./core.ts')
  it('laisse passer /model opus, /effort high, /fast, /compact, /clear, /approvals', () => {
    for (const c of ['/model opus', '/effort high', '/fast', '/compact', '/clear', '/new', '/approvals', ' /model gpt-5.1 ']) expect(checkCommand(c)).toBe(c.trim())
  })
  it('refuse tout le reste', () => {
    for (const c of ['/model opus; rm -rf', 'bonjour', '/clear\nrm', '/exit', '/model a b']) expect(() => checkCommand(c)).toThrow()
  })
})

describe('activité courte (« now »)', async () => {
  const { shortNow } = await import('./titles.ts')
  it('coupe au mot entier, jamais au milieu, et tient en 40 caractères', () => {
    expect(shortNow('ajuste les boutons et les logos officiels de la liste des sessions')).toBe('ajuste les boutons et les logos')
    expect(shortNow('déploie sur le VPS.')).toBe('déploie sur le VPS')
    expect(shortNow('termine et pousse tout sur main, puis redémarre le daemon').length).toBeLessThanOrEqual(40)
  })
})

describe('écran bloqué par un dialogue (dialogOnScreen)', async () => {
  const { dialogOnScreen } = await import('./mux.ts')
  it('menu avec curseur ❯ et touches indiquées (proposition d’autocompact, mise à jour…)', () => {
    const screen = ['', '  Your context is at 400k tokens. Enable auto-compact?', '', '  ❯ 1. Yes, enable auto-compact', '    2. Not now', '', '  Enter to select · Esc to dismiss'].join('\n')
    expect(dialogOnScreen(screen)).toMatch(/auto-compact/)
    const update = ['  A new version is available. Update now?', '  ❯ Yes', '    No', '  esc to skip'].join('\n')
    expect(dialogOnScreen(update)).toMatch(/Update now/)
  })
  it('question [y/n] en fin de ligne', () => {
    expect(dialogOnScreen('Compacting conversation…\nContinue? [y/n]: ')).toMatch(/Continue/)
  })
  it('champ de saisie normal de Claude Code (❯ seul) : rien', () => {
    expect(dialogOnScreen('● Terminé.\n\n❯ \n  ? for shortcuts')).toBeUndefined()
    expect(dialogOnScreen('› Ask Codex to do anything\n  ← for agents')).toBeUndefined()
  })
})

describe('catégories inventées supprimées', async () => {
  const { ConversationStore } = await import('./conversations.ts')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  it('ce qui était rangé dans « cash » ou « design » repart à classer, les catégories et leurs exemples disparaissent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-db-'))
    const s = new ConversationStore(dir)
    s.import([
      { id: 'a', source: 'chatgpt', title: 'Budget du jeu', createdAt: 1, updatedAt: 2, messages: [{ role: 'user', text: 'Combien coûte un trailer pour arcade ?', at: 1 }, { role: 'assistant', text: 'Environ…', at: 2 }] },
      { id: 'b', source: 'claude', title: 'Site vitrine', createdAt: 1, updatedAt: 3, messages: [{ role: 'user', text: 'Refais la home de shop-demo', at: 1 }] },
    ] as any)
    const cash = s.ensureCategory('cash')
    s.setClassification('a', { projectId: cash, status: 'auto', reason: 'x', confidence: 0.9 })
    s.correct('b', s.ensureCategory('design'))
    expect(s.categories().length).toBe(2)
    expect(s.dropInventedCategories()).toBe(2)
    expect(s.categories()).toEqual([])
    expect(s.corrections()).toEqual([])
    expect(s.unclassified(10).map((c) => c.id).sort()).toEqual(['a', 'b'])
    const t = tr(CM)
    expect(s.excerpt('a').startsWith(t.said(t.me, 'Combien coûte un trailer pour arcade'))).toBe(true)
    s.db.close()
    fs.rmSync(dir, { recursive: true })
  })
})

describe('messages collés / dictés', async () => {
  const { unwrapPasted } = await import('./transcripts.ts')
  it('garde le texte d’un bloc pasted_content', () => {
    expect(unwrapPasted('\n\n<pasted_content id="32fa">\nOuais, je disais…\n</pasted_content>')).toBe('Ouais, je disais…')
  })
})

describe('messages weevils collés (send-keys long → pasted_content)', async () => {
  const { readMore } = await import('./transcripts.ts')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  it('un exemple réel de 55639800…jsonl : attribué à weevils, texte dépouillé ; un collé de l’utilisateur reste à l’utilisateur', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-tr-'))
    const file = path.join(dir, '55639800-e327-46ce-bef8-310477c7d9e2.jsonl')
    const lines = [
      { type: 'user', uuid: 'u1', timestamp: '2026-11-09T05:40:00Z', message: { role: 'user', content: '\n\n<pasted_content id="6f2b">\n[weevils] Trois retours (les précédents ont été bloqués par une boîte de dialogue dans ta session, c\'est réglé). 1) Liste des projets…\n</pasted_content>' } },
      { type: 'user', uuid: 'u2', timestamp: '2026-11-09T05:41:00Z', message: { role: 'user', content: [{ type: 'text', text: '\n\n<pasted_content id="32fa">\nOuais, je disais ce qui serait bien, c\'est que tu fasses la page repos.\n</pasted_content>' }] } },
      { type: 'user', uuid: 'u3', timestamp: '2026-11-09T05:42:00Z', message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' } },
    ]
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const t = { id: '55639800-e327-46ce-bef8-310477c7d9e2', tool: 'claude' as const, file, cwd: '', openedAt: 0, lastActivityAt: 0, workStartedAt: null, phase: 'idle' as const, messages: [], subagents: [], offset: 0, partial: '', queued: [] }
    readMore(t as any, fs.statSync(file).size)
    expect(t.messages.map((m: any) => [m.role, m.text.slice(0, 40)])).toEqual([
      ['orchestrator', 'Trois retours (les précédents ont été bl'],
      ['user', 'Ouais, je disais ce qui serait bien, c\'e'],
    ])
    fs.rmSync(dir, { recursive: true })
  })
})

describe('confirmation « Switch model? »', async () => {
  const { dialogOnScreen } = await import('./mux.ts')
  it('menu numéroté sans touches indiquées : reconnu', () => {
    const screen = ['  Switch model?', '  Your next response will be slower and use more tokens', '  ❯ 1. Yes, switch to Sonnet 5.5', '    2. No, go back'].join('\n')
    expect(dialogOnScreen(screen)).toBe('Switch model?')
  })
})
