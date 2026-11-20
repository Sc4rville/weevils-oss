// Chargé avant chaque fichier de test (setupFiles de vite.config.ts), avant ses imports : config.ts lit HOME et les
// WEEVILS_* au chargement. Les tests ne lisent ni n'écrivent jamais la vraie config du développeur (~/.config/weevils,
// ~/.local/share/weevils, ~/.claude.json, ~/.codex) : un HOME jetable par fichier, la langue fixée, pas d'orchestrateur.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'

const root = process.env.WEEVILS_TEST_ROOT || os.tmpdir()
const home = fs.mkdtempSync(path.join(root, 'home-'))
// Rien de l'environnement du développeur : une session lancée par weevils hérite de toute sa config (WEEVILS_*, clés).
for (const k of Object.keys(process.env))
  if ((/^WEEVILS_/.test(k) && !/^WEEVILS_(LIVE_|TEST_ROOT)/.test(k)) || /^(OPENAI_API_KEY|CARTESIA_|DEVIL_|ANTHROPIC_)/.test(k)) delete process.env[k]
Object.assign(process.env, {
  HOME: home,
  TMUX_TMPDIR: home,
  WEEVILS_CONFIG: '/dev/null',
  WEEVILS_MACHINE: 'test',
  WEEVILS_ORCHESTRATOR: '0',
  WEEVILS_LANG: 'en',
})
delete process.env.TMUX
delete process.env.TMUX_PANE
delete process.env.INVOCATION_ID
delete process.env.CODEX_HOME
delete process.env.WEEVILS_PROJECTS
// Le HOME jetable part avec le fichier de test.
const clean = () => fs.rmSync(home, { recursive: true, force: true })
afterAll(clean)

// weevilsd trusts a local caller by the machine's local token (server/http.ts isLocal), configured at its start
// (server/index.ts). Here the same, with a fixed test token: a fake request « from this machine » carries
// TEST_LOCAL_TOKEN (test/local-token.ts) as weevils-cli does.
const { configureLocalAuth } = await import('../server/http.ts')
const { TEST_LOCAL_TOKEN } = await import('./local-token.ts')
configureLocalAuth({ token: TEST_LOCAL_TOKEN })
