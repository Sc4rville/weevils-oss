import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ProviderHealth } from './provider-health.ts'
import type { QuotaInfo } from '../shared/infra.ts'

const dirs: string[] = []
const file = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-health-')); dirs.push(d); return path.join(d, 'health.json') }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
const now = 1794586000000
const quota = (percent: number, at = now, reset: number | null = now + 3600000): QuotaInfo => ({ ok: true, at, source: 'fixture', windows: [{ kind: 'week', percent, resetsAt: reset }] })

it('persists both exhausted providers, keeps a real reset, and waits for evidence rather than expiring the hold', async () => {
  const f = file(), read = vi.fn(async () => ({ claude: quota(100), codex: quota(100, now, null) }))
  const h = new ProviderHealth(f, read, () => true)
  await h.refresh(now)
  expect(h.canUse('claude')).toBe(false); expect(h.canUse('codex')).toBe(false)
  expect(h.block('codex')?.resetAt).toBeNull()
  expect(h.block('claude')?.resetAt).toBe(now + 3600000)
  const reload = new ProviderHealth(f, read, () => true)
  await reload.refresh(now + 7200000) // old observation cannot prove a reset
  expect(reload.canUse('claude')).toBe(false)
  expect(reload.canUse('codex')).toBe(false)
  expect(fs.statSync(f).mode & 0o777).toBe(0o600)
  read.mockResolvedValue({ claude: quota(0, now + 7260000), codex: quota(100, now + 7260000, null) })
  await reload.refresh(now + 7260000)
  expect(reload.canUse('claude')).toBe(true); expect(reload.canUse('codex')).toBe(false)
})

it('records a quota stop once, rejects stale/error evidence and polls without aggressive retries', async () => {
  const read = vi.fn(async () => ({ claude: quota(0), codex: quota(54) })), h = new ProviderHealth(file(), read, () => true)
  await h.refresh(now)
  h.stop('codex', now + 1)
  expect(h.canUse('codex')).toBe(false)
  for (let i = 1; i < 60; i++) await h.refresh(now + i * 1000)
  expect(read).toHaveBeenCalledOnce()
  read.mockResolvedValue({ claude: quota(0), codex: { ...quota(0, now + 60000), error: 'offline' } })
  await h.refresh(now + 60000)
  expect(h.canUse('codex')).toBe(false)
  read.mockResolvedValue({ claude: quota(0), codex: quota(0, now + 120000) })
  await h.refresh(now + 120000)
  h.stop('codex', now + 1)
  expect(h.canUse('codex')).toBe(true)
})

it('never treats credentials missing as ready or malformed quota values as a recovery', async () => {
  const h = new ProviderHealth(file(), async () => ({ claude: quota(0), codex: quota(NaN) }), t => t !== 'claude')
  h.stop('codex', now - 1)
  await h.refresh(now)
  expect(h.canUse('claude')).toBe(false); expect(h.canUse('codex')).toBe(false)
})

it('does not erase persisted holds when the state file is corrupt', () => {
  const f = file(), read = vi.fn(async () => ({ claude: quota(0), codex: quota(0) }))
  for (const content of ['{', '{"claude":{},"codex":null}']) {
    fs.writeFileSync(f, content)
    expect(() => new ProviderHealth(f, read, () => true)).toThrow()
    expect(fs.readFileSync(f, 'utf8')).toBe(content)
  }
  expect(read).not.toHaveBeenCalled()
})
