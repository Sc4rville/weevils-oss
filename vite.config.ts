import fs from 'node:fs'
import os from 'node:os'
import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Domaine public (HTTPS devant le serveur local) : active le HMR à travers le proxy. Lu dans la config de l'utilisateur.
function configured(name: string): string | undefined {
  if (process.env[name]) return process.env[name]
  try {
    const file = process.env.WEEVILS_CONFIG ?? `${os.homedir()}/.config/weevils/env`
    return new RegExp(`^${name}=(.*)$`, 'm').exec(fs.readFileSync(file, 'utf8'))?.[1].trim() || undefined
  } catch {
    return undefined
  }
}
const publicUrl = configured('WEEVILS_PUBLIC_URL')
const publicHost = process.env.WEEVILS_HOST ?? (publicUrl ? new URL(publicUrl).host : undefined)

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4178,
    strictPort: true,
    allowedHosts: publicHost ? [publicHost] : [],
    hmr: publicHost ? { protocol: 'wss', host: publicHost, clientPort: 443 } : undefined,
    // weevilsd sert l'API ; en dev, le serveur de dev la relaie (flux SSE compris).
    proxy: { '/api': { target: 'http://127.0.0.1:4179', changeOrigin: false } },
  },
  // Tests en mode développement de React (act), même si le shell a NODE_ENV=production.
  // setup-env : HOME jetable et WEEVILS_* fixés avant tout import, jamais la vraie config du développeur.
  // test/live (contre un vrai weevilsd) est trouvé comme les autres mais sauté sans WEEVILS_LIVE_TEST=1.
  // .claude/ : worktrees d'agents (ignorés par git), jamais testés depuis ici.
  test: { environment: 'node', env: { NODE_ENV: 'test' }, setupFiles: ['test/setup-env.ts'], globalSetup: ['test/global-setup.ts'], exclude: [...configDefaults.exclude, '.claude/**'] },
})
