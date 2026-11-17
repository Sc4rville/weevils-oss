// Travail d'arrière-plan d'une session Claude Code (server/background.ts) : sous-agents, étapes de workflow, commandes
// run_in_background ; fins annoncées, bilans de fin de tour, processus redémarré, borne de sûreté, détail lu par la fin.
// Vrais fichiers dans un dossier temporaire, aux formats de Claude Code 2.1.318 (copiés de vrais transcripts).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PS_EVERY_MS, PS_KEEP_MS, STALE_BG_MS, STALE_TOOL_MS, backgroundOf, bgLine, emptyBg, forgetPs, logJobsIn, shellLabel, parsePs, procInfo, procInfoIn, psProcInfo, subagentSteps, type BgState, type ProcInfo } from './background.ts'
import { TranscriptStore } from './transcripts.ts'

const MIN = 60_000
const SID = '0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d'
let root: string
let file: string
let dir: string

const iso = (ms: number) => new Date(ms).toISOString()
const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l) + '\n').join('')
const write = (f: string, lines: unknown[]) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, jsonl(lines))
}
const touch = (f: string, at: number) => fs.utimesSync(f, new Date(at), new Date(at))
const writeJson = (f: string, o: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(o))
}

// Lignes du transcript principal.
const toolUse = (id: string, name: string, input: Record<string, unknown>, at: number) => ({
  type: 'assistant',
  timestamp: iso(at),
  message: { id: `msg-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' },
})
const toolResult = (id: string, text: string, at: number, result?: Record<string, unknown>, isError = false) => ({
  type: 'user',
  timestamp: iso(at),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] },
  ...(result ? { toolUseResult: result } : {}),
})
const notification = (taskId: string, toolUseId: string, status: string, summary: string, at: number) => ({
  type: 'queue-operation',
  operation: 'enqueue',
  timestamp: iso(at),
  sessionId: SID,
  content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/tmp/claude-1000/proj/${SID}/tasks/${taskId}.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`,
})
const turnEnd = (at: number, pending: { workflows?: number; agents?: number } = {}) => ({
  type: 'system',
  subtype: 'turn_duration',
  timestamp: iso(at),
  durationMs: 1000,
  ...(pending.workflows ? { pendingWorkflowCount: pending.workflows } : {}),
  ...(pending.agents ? { pendingBackgroundAgentCount: pending.agents } : {}),
})
// Lignes d'un sous-agent.
const subLine = (at: number, content: unknown[], type = 'assistant') => ({ type, isSidechain: true, timestamp: iso(at), message: { role: type, content } })

/** Le fil principal lu comme le fait transcripts.ts. */
function stateOf(lines: unknown[]): BgState {
  const bg = emptyBg()
  for (const o of lines) bgLine(bg, JSON.parse(JSON.stringify(o)), Date.parse((o as { timestamp?: string }).timestamp ?? '') || 0)
  return bg
}
const byId = <T extends { id: string }>(list: T[], id: string) => list.find((s) => s.id === id)

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-background-'))
  file = path.join(root, 'proj', `${SID}.jsonl`)
  dir = file.slice(0, -'.jsonl'.length)
  fs.mkdirSync(path.dirname(file), { recursive: true })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('sous-agents (Agent/Task)', () => {
  it('B1 lancé en arrière-plan : working tant que rien ne dit qu’il a fini ; la notification le termine', () => {
    const now = Date.now()
    const sub = path.join(dir, 'subagents', 'agent-a1.jsonl')
    write(sub, [subLine(now - 60_000, [{ type: 'text', text: 'Je regarde.' }]), subLine(now - 5000, [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }])])
    writeJson(path.join(dir, 'subagents', 'agent-a1.meta.json'), { agentType: 'general-purpose', description: 'Real UI captures', toolUseId: 'tu1', requestShape: 'background' })
    const lines: unknown[] = [
      toolUse('tu1', 'Agent', { description: 'Real UI captures', subagent_type: 'general-purpose', prompt: '…', run_in_background: true }, now - 61_000),
      toolResult('tu1', 'Async agent launched', now - 60_500, { isAsync: true, status: 'async_launched', agentId: 'a1', description: 'Real UI captures' }),
      turnEnd(now - 59_000, { agents: 1 }),
    ]
    let list = backgroundOf(file, stateOf(lines), now)
    expect(list).toEqual([{ id: 'a1', kind: 'agent', label: 'Real UI captures', activity: 'Bash · Run the tests', status: 'working', startedAt: now - 61_000, endedAt: undefined }])

    lines.push(notification('a1', 'tu1', 'completed', 'Agent "Real UI captures" finished', now - 1000))
    list = backgroundOf(file, stateOf(lines), now)
    expect(list[0]).toMatchObject({ id: 'a1', status: 'done', endedAt: now - 1000 })
  })

  it('B2 méta « finished » seule, échec et arrêt annoncés', () => {
    const now = Date.now()
    for (const id of ['f', 'x', 'k']) write(path.join(dir, 'subagents', `agent-${id}.jsonl`), [subLine(now - 10 * MIN, [{ type: 'text', text: 'ok' }])])
    for (const id of ['f', 'x', 'k']) touch(path.join(dir, 'subagents', `agent-${id}.jsonl`), now - 9 * MIN)
    writeJson(path.join(dir, 'subagents', 'agent-f.meta.json'), { description: 'meta finished', requestShape: 'background', finished: true })
    writeJson(path.join(dir, 'subagents', 'agent-x.meta.json'), { description: 'failed one', requestShape: 'background' })
    writeJson(path.join(dir, 'subagents', 'agent-k.meta.json'), { description: 'killed one', requestShape: 'background' })
    const bg = stateOf([notification('x', 'tux', 'failed', 'Agent failed', now - 8 * MIN), notification('k', 'tuk', 'killed', 'Agent stopped', now - 8 * MIN)])
    const list = backgroundOf(file, bg, now)
    expect(byId(list, 'f')?.status).toBe('done')
    expect(byId(list, 'x')?.status).toBe('failed')
    expect(byId(list, 'k')?.status).toBe('stopped')
  })

  it('B3 relancé après sa fin (écrit après la notification) : retravaille', () => {
    const now = Date.now()
    const sub = path.join(dir, 'subagents', 'agent-r.jsonl')
    write(sub, [subLine(now - 5 * MIN, [{ type: 'text', text: 'again' }])])
    writeJson(path.join(dir, 'subagents', 'agent-r.meta.json'), { description: 'resumed', requestShape: 'background' })
    const list = backgroundOf(file, stateOf([notification('r', 'tur', 'completed', 'done', now - 4 * MIN)]), now)
    expect(byId(list, 'r')?.status).toBe('working')
  })

  it('B4 au premier plan : fini quand l’outil rend son résultat', () => {
    const now = Date.now()
    write(path.join(dir, 'subagents', 'agent-fg.jsonl'), [subLine(now - 2 * MIN, [{ type: 'text', text: 'Found it.' }])])
    touch(path.join(dir, 'subagents', 'agent-fg.jsonl'), now - 2 * MIN)
    writeJson(path.join(dir, 'subagents', 'agent-fg.meta.json'), { description: 'explore', toolUseId: 'tufg', requestShape: 'foreground' })
    const launch = toolUse('tufg', 'Task', { description: 'explore', subagent_type: 'Explore', prompt: 'find' }, now - 3 * MIN)
    expect(backgroundOf(file, stateOf([launch]), now)[0].status).toBe('working')
    const list = backgroundOf(file, stateOf([launch, toolResult('tufg', 'Found it.', now - MIN, { status: 'completed', agentId: 'fg' })]), now)
    expect(list[0]).toMatchObject({ id: 'fg', status: 'done', endedAt: now - MIN, activity: 'Found it.' })
  })

  it('B4b au premier plan, son rapport dit « running in background » : fini quand même (seuls les champs du résultat comptent)', () => {
    const now = Date.now()
    const lines = [
      toolUse('tuF', 'Agent', { description: 'Start preview' }, now - 5 * MIN),
      toolResult('tuF', 'Done. The preview server is running in background on port 4174.', now - 4 * MIN, { status: 'completed', agentId: 'afg1', content: [] }),
      turnEnd(now - 4 * MIN + 100),
    ]
    const bg = stateOf(lines)
    expect(bg.launches.tuF).toMatchObject({ async: false, ended: { status: 'done' } })
    expect(backgroundOf(file, bg, now, () => ({ startedAt: now - 60 * MIN, shells: ['bash shell-snapshots vite'] })).filter((s) => s.status === 'working')).toEqual([])
  })

  it('B5 tout juste lancé, pas encore de fichier : déjà dans la liste', () => {
    const now = Date.now()
    const lines = [toolUse('tu9', 'Agent', { description: 'Write copy', run_in_background: true }, now - 2000), toolResult('tu9', 'launched', now - 1900, { isAsync: true, status: 'async_launched', agentId: 'a9' })]
    expect(backgroundOf(file, stateOf(lines), now)).toEqual([{ id: 'a9', kind: 'agent', label: 'Write copy', activity: 'Write copy', status: 'working', startedAt: now - 2000, endedAt: undefined }])
  })
})

describe('workflows', () => {
  const wf = 'wf_03a7f8b5-eb5'
  const wfDir = () => path.join(dir, 'subagents', 'workflows', wf)
  const launch = (now: number) => [
    toolUse('tuw', 'Workflow', { script: "export const meta = {\n  name: 'memory-build',\n  description: 'Build the memory page',\n}" }, now - 10 * MIN),
    toolResult('tuw', `Workflow launched in background. Task ID: wpam\nTranscript dir: ${wfDir()}`, now - 10 * MIN + 50, { status: 'async_launched', taskId: 'wpam', taskType: 'local_workflow', workflowName: 'memory-build', runId: wf, summary: 'Build the memory page' }),
    turnEnd(now - 10 * MIN + 100, { workflows: 1 }),
  ]

  it('W1 étapes lancées (journal) : working, puis done avec leur résultat ; nom et phase', () => {
    const now = Date.now()
    write(path.join(wfDir(), 'journal.jsonl'), [{ type: 'launched' }, { type: 'started', agentId: 's1', label: 'build:weevil', phase: 'Build' }, { type: 'started', agentId: 's2', label: 'build:page', phase: 'Build' }, { type: 'result', agentId: 's2', result: 'Page built. Tests pass.' }])
    write(path.join(wfDir(), 'agent-s1.jsonl'), [subLine(now - 9 * MIN, [{ type: 'tool_use', name: 'Edit', input: { file_path: '/x/page.tsx' } }])])
    write(path.join(wfDir(), 'agent-s2.jsonl'), [subLine(now - 9 * MIN, [{ type: 'text', text: 'Page built.' }])])
    writeJson(path.join(wfDir(), 'agent-s1.meta.json'), { agentType: 'workflow-subagent', description: 'build:weevil', workflowPhase: 'Build' })
    const list = backgroundOf(file, stateOf(launch(now)), now)
    expect(list.map((s) => [s.id, s.kind, s.workflow, s.phase, s.label, s.status])).toEqual([
      ['s1', 'step', 'memory-build', 'Build', 'build:weevil', 'working'],
      ['s2', 'step', 'memory-build', 'Build', 'build:page', 'done'],
    ])
    expect(byId(list, 's1')?.activity).toBe('Edit · /x/page.tsx')
    expect(byId(list, 's2')?.activity).toBe('Page built.')
  })

  it('W2 lancé, aucune étape encore : le workflow lui-même tourne', () => {
    const now = Date.now()
    write(path.join(wfDir(), 'journal.jsonl'), [{ type: 'launched' }])
    expect(backgroundOf(file, stateOf(launch(now)), now)).toEqual([
      { id: wf, kind: 'step', label: 'memory-build', activity: 'Build the memory page', workflow: 'memory-build', status: 'working', startedAt: now - 10 * MIN, endedAt: undefined },
    ])
  })

  it('W3 fin du workflow annoncée : une étape sans résultat a été coupée', () => {
    const now = Date.now()
    write(path.join(wfDir(), 'journal.jsonl'), [{ type: 'started', agentId: 's1', label: 'critic:final', phase: 'Critic' }])
    write(path.join(wfDir(), 'agent-s1.jsonl'), [subLine(now - 9 * MIN, [{ type: 'text', text: 'checking' }])])
    const list = backgroundOf(file, stateOf([...launch(now), notification('wpam', 'tuw', 'completed', 'Dynamic workflow "memory-build" completed', now - MIN)]), now)
    expect(list.map((s) => [s.id, s.status])).toEqual([['s1', 'stopped']])
  })

  it('W5 repris (resumeFromRunId, même runId) : le run repris compte, pas l’ancien qu’on a coupé', () => {
    const now = Date.now()
    const t0 = now - 10 * MIN
    write(path.join(wfDir(), 'journal.jsonl'), [{ type: 'launched' }, { type: 'started', agentId: 'old', label: 'migrate:a', phase: 'Migrate' }, { type: 'started', agentId: 'aaa111', label: 'migrate:ui-core', phase: 'Migrate' }])
    write(path.join(wfDir(), 'agent-old.jsonl'), [subLine(t0 + 10_000, [{ type: 'text', text: 'start' }])])
    touch(path.join(wfDir(), 'agent-old.jsonl'), t0 + 30_000)
    write(path.join(wfDir(), 'agent-aaa111.jsonl'), [subLine(now - MIN, [{ type: 'text', text: 'go' }])])
    touch(path.join(wfDir(), 'agent-aaa111.jsonl'), now - MIN)
    const lines = [
      toolUse('tu1', 'Workflow', { script: "name: 'memory-build'" }, t0),
      toolResult('tu1', 'Workflow launched in background. Task ID: wyib', t0 + 50, { status: 'async_launched', taskId: 'wyib', runId: wf, workflowName: 'memory-build' }),
      turnEnd(t0 + 5000, { workflows: 1 }),
      toolUse('tu2', 'TaskStop', { task_id: 'wyib' }, t0 + 60_000),
      toolUse('tu3', 'Workflow', { scriptPath: `/x/memory-build-${wf}.js`, resumeFromRunId: wf }, t0 + 66_000),
      toolResult('tu3', 'Workflow launched in background. Task ID: w8jo', t0 + 66_100, { status: 'async_launched', taskId: 'w8jo', runId: wf, workflowName: 'memory-build' }),
      turnEnd(t0 + 70_000, { workflows: 1 }),
    ]
    const list = backgroundOf(file, stateOf(lines), now, () => ({ startedAt: t0 - 60 * MIN, shells: [] }))
    expect(list.map((s) => [s.id, s.status])).toEqual([
      ['old', 'stopped'],
      ['aaa111', 'working'],
    ])
  })

  it('W6 étape finie : la première phrase de son rapport (sans l’annotation du harnais), jamais « StructuredOutput »', () => {
    const now = Date.now()
    write(path.join(wfDir(), 'journal.jsonl'), [
      { type: 'started', agentId: 's1', label: 'review:a', phase: 'Review' },
      { type: 'started', agentId: 's2', label: 'build:server', phase: 'Build' },
      { type: 'started', agentId: 's3', label: 'review:b', phase: 'Review' },
      { type: 'result', agentId: 's1' },
      { type: 'result', agentId: 's2', result: '[harness: subagent output matched instruction-shaped pattern(s): harness-envelope-tag.]\n\nThe server side is done. All checks pass.' },
    ])
    const ending = [subLine(now - 2 * MIN, [{ type: 'tool_use', name: 'Read', input: { file_path: '/x/a.ts' } }]), subLine(now - MIN, [{ type: 'tool_use', name: 'StructuredOutput', input: { findings: [] } }])]
    write(path.join(wfDir(), 'agent-s1.jsonl'), ending)
    write(path.join(wfDir(), 'agent-s2.jsonl'), ending)
    write(path.join(wfDir(), 'agent-s3.jsonl'), ending)
    const list = backgroundOf(file, stateOf(launch(now)), now)
    expect(byId(list, 's1')?.activity).toBe('review:a')
    expect(byId(list, 's2')?.activity).toBe('The server side is done.')
    // En cours, le dernier vrai pas : pas l'outil de rendu.
    expect(byId(list, 's3')).toMatchObject({ status: 'working', activity: 'Read · /x/a.ts' })
  })

  it('W4 nom tiré du script quand le lancement n’est pas dans le fil', () => {
    const now = Date.now()
    write(path.join(wfDir(), 'journal.jsonl'), [{ type: 'started', agentId: 's1', label: 'x', phase: 'P' }])
    write(path.join(wfDir(), 'agent-s1.jsonl'), [subLine(now - 1000, [{ type: 'text', text: 'go' }])])
    fs.mkdirSync(path.join(dir, 'workflows', 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'workflows', 'scripts', `weevils-softwares-build-${wf}.js`), '')
    expect(backgroundOf(file, emptyBg(), now)[0]).toMatchObject({ workflow: 'weevils-softwares-build', status: 'working' })
  })
})

describe('commandes d’arrière-plan (Bash run_in_background)', () => {
  const launch = (id: string, task: string, at: number, description = 'Render the clips') => [
    toolUse(id, 'Bash', { command: 'node tools/batch.mjs', description, run_in_background: true }, at),
    toolResult(id, `Command running in background with ID: ${task}`, at + 50, { stdout: '', stderr: '', interrupted: false, backgroundTaskId: task }),
  ]

  it('S1 lancée → working ; notification completed / failed / killed ; TaskStop', () => {
    const now = Date.now()
    const lines: unknown[] = [...launch('t1', 'b1', now - 5 * MIN), ...launch('t2', 'b2', now - 5 * MIN, 'Wait for link'), ...launch('t3', 'b3', now - 5 * MIN, 'Loop'), ...launch('t4', 'b4', now - 5 * MIN, 'Watch')]
    let list = backgroundOf(file, stateOf(lines), now)
    expect(list.map((s) => [s.id, s.kind, s.status])).toEqual([
      ['b1', 'shell', 'working'],
      ['b2', 'shell', 'working'],
      ['b3', 'shell', 'working'],
      ['b4', 'shell', 'working'],
    ])
    expect(list[0].label).toBe('Render the clips')
    lines.push(
      notification('b1', 't1', 'completed', 'Background command "Render the clips" completed (exit code 0)', now - MIN),
      notification('b2', 't2', 'failed', 'Background command "Wait for link" failed with exit code 144', now - MIN),
      notification('b3', 't3', 'killed', 'Background command "Loop" was stopped', now - MIN),
      toolUse('t5', 'TaskStop', { task_id: 'b4' }, now - 30_000),
    )
    list = backgroundOf(file, stateOf(lines), now)
    expect(list.map((s) => [s.id, s.status])).toEqual([
      ['b1', 'done'],
      ['b2', 'failed'],
      ['b3', 'stopped'],
      ['b4', 'stopped'],
    ])
  })

  it('S2 sa dernière ligne de sortie est son activité ; le détail montre ses dernières lignes', () => {
    const now = Date.now()
    const lines = [...launch('t1', 'b1', now - MIN), notification('b0', 'tx', 'completed', 'x', now - 2 * MIN)]
    // Le dossier des sorties est celui que Claude Code a annoncé : on en fabrique un vrai.
    const tasks = path.join(root, 'tasks')
    const bg = stateOf(lines)
    bg.notes.b0.outputFile = path.join(tasks, 'b0.output')
    fs.mkdirSync(tasks, { recursive: true })
    fs.writeFileSync(path.join(tasks, 'b1.output'), 'frame 1/3\nframe 2/3\n')
    const [s] = backgroundOf(file, bg, now)
    expect(s).toMatchObject({ id: 'b1', activity: 'frame 2/3', status: 'working' })
    expect(subagentSteps(file, bg, s).map((x) => x.text)).toEqual(['frame 1/3', 'frame 2/3'])
  })
})

describe('commandes passées en arrière-plan en cours de route, surveillances (Monitor)', () => {
  // Lignes réelles (session cfc800be, 2026-11-10 02:01–02:17), raccourcies.
  const fgBash = (at: number) => toolUse('toolu_01VWZ', 'Bash', { command: 'python3 ~/scratch/essai/drive.py', description: 'Run the install driver', timeout: 600000 }, at)
  const movedResult = (at: number) =>
    toolResult('toolu_01VWZ', 'Command did not complete within its 600s timeout and was moved to the background (ID: b4tp6nlj1). Output is being written to: /tmp/claude-1000/-home-yann-projects-weevils-content/cfc800be/tasks/b4tp6nlj1.output', at, {
      stdout: '',
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      backgroundTaskId: 'b4tp6nlj1',
      timedOutAfterMs: 600000,
    })
  const monitor = (at: number) => [
    toolUse('toolu_01Gpk', 'Monitor', { command: "until grep -qE 'exit ' ~/logs/essai-drive.log; do sleep 5; done", description: 'Wait for install driver to finish', timeout: '900000' }, at),
    toolResult('toolu_01Gpk', 'Monitor started (task bnl3rhcuk, expires in 5m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event.', at + 40, { taskId: 'bnl3rhcuk', timeoutMs: 300000, persistent: false }),
  ]
  const monitorEvent = (event: string, at: number) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(at), sessionId: SID, content: `<task-notification>\n<task-id>bnl3rhcuk</task-id>\n<summary>Monitor event: "Wait for install driver to finish"</summary>\n<event>${event}</event>\n</task-notification>` })
  const one: ProcInfo = { startedAt: Date.now() - 120 * MIN, shells: ['bash -c source shell-snapshots/x && eval python3 drive.py'] }

  it('M1 Bash au premier plan passé en arrière-plan après 600 s : une commande d’arrière-plan, partie à son lancement ; TaskStop la coupe', () => {
    const now = Date.now()
    const lines: unknown[] = [fgBash(now - 11 * MIN), movedResult(now - MIN), turnEnd(now - MIN + 100)]
    let [s] = backgroundOf(file, stateOf(lines), now, () => one)
    expect(s).toMatchObject({ id: 'b4tp6nlj1', kind: 'shell', label: 'Run the install driver', status: 'working', startedAt: now - 11 * MIN })
    lines.push(toolUse('toolu_01Cpp', 'TaskStop', { task_id: 'b4tp6nlj1' }, now - 30_000))
    ;[s] = backgroundOf(file, stateOf(lines), now, () => one)
    expect(s).toMatchObject({ id: 'b4tp6nlj1', status: 'stopped' })
  })

  it('M2 Bash au premier plan fini normalement : rien, et rien ne reste en mémoire', () => {
    const now = Date.now()
    const bg = stateOf([fgBash(now - MIN), toolResult('toolu_01VWZ', 'ok', now - 30_000, { stdout: 'ok', stderr: '', interrupted: false })])
    expect(backgroundOf(file, bg, now, () => one)).toEqual([])
    expect(bg.calls).toEqual({})
  })

  it('M3 Monitor : working ; ses événements ne le terminent pas ; son expiration, si', () => {
    const now = Date.now()
    const lines: unknown[] = [...monitor(now - 4 * MIN), monitorEvent('==&gt; /tmp/x.log &lt;==\nPASS step 1', now - 2 * MIN)]
    let [s] = backgroundOf(file, stateOf(lines), now, () => one)
    expect(s).toMatchObject({ id: 'bnl3rhcuk', kind: 'shell', label: 'Wait for install driver to finish', status: 'working' })
    lines.push(monitorEvent('[Monitor expired after 5m with no events delivered. Re-arm it if you still need the watch.]', now - 10_000))
    ;[s] = backgroundOf(file, stateOf(lines), now, () => one)
    expect(s.status).toBe('done')
    // Expiration passée sans notice lue : fini quand même, à l'heure dite.
    ;[s] = backgroundOf(file, stateOf(monitor(now - 6 * MIN)), now, () => one)
    expect(s).toMatchObject({ status: 'done', endedAt: now - 6 * MIN + 40 + 300000 })
  })
})

describe('bilan de fin de tour (pending*)', () => {
  it('T1 compteurs à 0 (absents) : ce qui a été lancé avant est fini ; jamais si la version ne les écrit pas', () => {
    const now = Date.now()
    write(path.join(dir, 'subagents', 'agent-a1.jsonl'), [subLine(now - 10 * MIN, [{ type: 'text', text: 'done' }])])
    touch(path.join(dir, 'subagents', 'agent-a1.jsonl'), now - 9 * MIN)
    writeJson(path.join(dir, 'subagents', 'agent-a1.meta.json'), { description: 'bg', toolUseId: 'tu1', requestShape: 'background' })
    const base = [toolUse('tu1', 'Agent', { description: 'bg', run_in_background: true }, now - 10 * MIN), toolResult('tu1', 'launched', now - 10 * MIN, { status: 'async_launched', agentId: 'a1' })]
    // Version qui écrit les compteurs : vu à 1, puis absent (0) → fini.
    expect(backgroundOf(file, stateOf([...base, turnEnd(now - 9.5 * MIN, { agents: 1 }), turnEnd(now - 8 * MIN)]), now)[0].status).toBe('done')
    // Jamais vu de compteur : leur absence ne prouve rien.
    expect(backgroundOf(file, stateOf([...base, turnEnd(now - 8 * MIN)]), now)[0].status).toBe('working')
  })
})

describe('processus et borne de sûreté', () => {
  const agent = (now: number, lastWrite: number) => {
    const f = path.join(dir, 'subagents', 'agent-a1.jsonl')
    write(f, [subLine(now - 60 * MIN, [{ type: 'text', text: 'long job' }])])
    touch(f, lastWrite)
    writeJson(path.join(dir, 'subagents', 'agent-a1.meta.json'), { description: 'long', requestShape: 'background' })
  }

  it('P1 rien d’écrit depuis plus de 20 min, aucun processus : coupé ; moins de 20 min : working', () => {
    const now = Date.now()
    agent(now, now - STALE_BG_MS - MIN)
    expect(backgroundOf(file, emptyBg(), now)[0]).toMatchObject({ status: 'stopped', endedAt: now - STALE_BG_MS - MIN })
    agent(now, now - STALE_BG_MS + MIN)
    expect(backgroundOf(file, emptyBg(), now)[0].status).toBe('working')
  })

  it('P2 une commande vivante sous claude ne prouve la vie que des commandes : un sous-agent muet depuis 20 min est coupé quand même', () => {
    const now = Date.now()
    // Sous-agent lancé il y a 6 h, jamais notifié, muet ; à côté, un serveur de dev lancé en arrière-plan qui tourne.
    agent(now, now - 3 * STALE_BG_MS)
    const lines = [toolUse('t1', 'Bash', { command: 'npm run dev', description: 'Dev server', run_in_background: true }, now - 6 * 60 * MIN), toolResult('t1', 'Command running in background with ID: b1', now - 6 * 60 * MIN, { backgroundTaskId: 'b1' })]
    const proc: ProcInfo = { startedAt: now - 7 * 60 * MIN, shells: ['/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1.sh && eval npm run dev'] }
    const list = backgroundOf(file, stateOf(lines), now, () => proc)
    expect(list.map((s) => [s.id, s.status])).toEqual([
      ['b1', 'working'],
      ['a1', 'stopped'],
    ])
  })

  it('P2b un sous-agent qui attend le résultat d’un outil a droit à une heure', () => {
    const now = Date.now()
    const f = path.join(dir, 'subagents', 'agent-a1.jsonl')
    write(f, [subLine(now - 60 * MIN, [{ type: 'tool_use', id: 'x', name: 'mcp__slow__crunch', input: {} }])])
    writeJson(path.join(dir, 'subagents', 'agent-a1.meta.json'), { description: 'long', requestShape: 'background' })
    touch(f, now - STALE_TOOL_MS + 5 * MIN)
    expect(backgroundOf(file, emptyBg(), now)[0].status).toBe('working')
    touch(f, now - STALE_TOOL_MS - MIN)
    expect(backgroundOf(file, emptyBg(), now)[0].status).toBe('stopped')
  })

  it('P3 claude redémarré depuis (--resume) : ce que l’ancien processus avait lancé est mort', () => {
    const now = Date.now()
    agent(now, now - MIN)
    const proc: ProcInfo = { startedAt: now - 2 * MIN, shells: [] }
    expect(backgroundOf(file, emptyBg(), now, () => proc)[0]).toMatchObject({ status: 'stopped' })
  })

  it('P4 commande d’arrière-plan : plus aucun bash sous claude → finie (après 30 s de grâce)', () => {
    const now = Date.now()
    const launch = (at: number) => [toolUse('t1', 'Bash', { command: 'sleep 100', run_in_background: true }, at), toolResult('t1', 'bg', at, { backgroundTaskId: 'b1' })]
    const none: ProcInfo = { startedAt: now - 60 * MIN, shells: [] }
    expect(backgroundOf(file, stateOf(launch(now - 10_000)), now, () => none)[0].status).toBe('working')
    expect(backgroundOf(file, stateOf(launch(now - 60_000)), now, () => none)[0].status).toBe('stopped')
    const one: ProcInfo = { startedAt: now - 60 * MIN, shells: ['bash -c shell-snapshots sleep 100'] }
    expect(backgroundOf(file, stateOf(launch(now - 60_000)), now, () => one)[0].status).toBe('working')
  })

  it('P5 le processus n’est consulté que si quelque chose semble tourner', () => {
    let calls = 0
    backgroundOf(file, emptyBg(), Date.now(), () => (calls++, null))
    expect(calls).toBe(0)
  })

  it.skipIf(process.platform !== 'linux')('P6 procInfo : démarrage du processus et ses bash « shell-snapshots », pas les autres enfants', async () => {
    const shell = spawn('bash', ['-c', 'sleep 30; true', '/home/u/.claude/shell-snapshots/snapshot-bash-test.sh'], { stdio: 'ignore' })
    const other = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 150))
      const p = procInfo(process.pid)!
      expect(p.startedAt).toBeLessThan(Date.now())
      expect(p.startedAt).toBeGreaterThan(Date.now() - 7 * 86400_000)
      expect(p.shells.some((c) => c.includes('snapshot-bash-test.sh'))).toBe(true)
      expect(p.shells.every((c) => c.includes('shell-snapshots'))).toBe(true)
      expect(procInfo(999_999_999)).toBeNull()
    } finally {
      shell.kill()
      other.kill()
    }
  })
})

// What `ps -ax -ww -o pid= -o ppid= -o stat= -o lstart= -o command=` prints on a Mac (LC_ALL=C): claude 61002 in a
// tmux pane, a background command and a foreground one under it (zsh sourcing a shell snapshot), an MCP server, a
// zombie, an earlier claude (61900) with nothing under it, and paths with spaces.
const PS_MAC = `    1     0 Ss   Sun Nov  1 09:00:01 2026 /sbin/launchd
  412     1 Ss   Sun Nov  1 09:00:09 2026 /usr/sbin/cfprefsd agent
60990     1 Ss   Fri Nov 13 18:02:11 2026 tmux -u -L weevils new-session -d -s wv-site-1b2c3d
61002 60990 Ss+  Fri Nov 13 19:28:34 2026 claude --dangerously-skip-permissions --session-id 0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d
61040 61002 S+   Fri Nov 13 19:28:36 2026 node /Users/u/Library/Application Support/mcp/server.js --stdio
61377 61002 S    Fri Nov 13 19:41:02 2026 /bin/zsh -c -l source /Users/u/.claude/shell-snapshots/snapshot-zsh-1794598862000-ab12cd.sh && setopt NO_EXTENDED_GLOB 2>/dev/null || true && eval 'npm run dev' < /dev/null && pwd -P >| /var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/claude-7f1a-cwd
61380 61377 S    Fri Nov 13 19:41:02 2026 npm run dev
61381 61380 S    Fri Nov 13 19:41:03 2026 node /Users/u/projects/my site/node_modules/.bin/vite
61502 61002 S    Fri Nov 13 19:55:40 2026 /bin/zsh -c -l source /Users/u/.claude/shell-snapshots/snapshot-zsh-1794598862000-ab12cd.sh && eval 'sleep 600'
61510 61002 Z    Fri Nov 13 19:56:00 2026 (git)
61900 60990 Ss+  Fri Nov 13 17:10:00 2026 claude --resume
61950 61040 S    Fri Nov 13 19:30:00 2026 /bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'true'
`

describe('processus sur un Mac (ps à la place de /proc)', () => {
  beforeEach(() => forgetPs())

  it('M1 parsePs : chaque ligne donne son pid, son parent, son démarrage (heure locale) et sa ligne de commande entière', () => {
    const t = parsePs(PS_MAC)
    expect(t.rows.size).toBe(12)
    expect(t.rows.get(61002)).toEqual({ startedAt: new Date(2026, 10, 13, 19, 28, 34).getTime(), zombie: false, cmd: 'claude --dangerously-skip-permissions --session-id 0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d' })
    // Un jour à un chiffre (« Nov  1 », deux espaces) et un chemin avec des espaces.
    expect(t.rows.get(1)?.startedAt).toBe(new Date(2026, 10, 1, 9, 0, 1).getTime())
    expect(t.rows.get(61381)?.cmd).toBe('node /Users/u/projects/my site/node_modules/.bin/vite')
    expect(t.rows.get(61510)?.zombie).toBe(true)
    expect(t.kids.get(61002)).toEqual([61040, 61377, 61502, 61510])
    expect(t.kids.get(60990)).toEqual([61002, 61900])
  })

  it('M2 parsePs : ce qui n’est pas une ligne de ps est ignoré (en-tête, erreur, date dans une autre langue, ligne vide)', () => {
    const t = parsePs(['  PID  PPID STAT STARTED COMMAND', 'ps: illegal option -- z', '', '  77     1 S    ven. 13 nov. 19:28:34 2026 claude', '   88     1 S    Fri Nov 13 19:28:34 2026 ok', '   89    88 R    Fri Nov 13 19:28:35 2026'].join('\n'))
    expect([...t.rows.keys()]).toEqual([88, 89])
    expect(t.rows.get(89)?.cmd).toBe('')
    expect(parsePs('').rows.size).toBe(0)
  })

  it('M3 procInfoIn : le démarrage de claude et ses commandes « shell-snapshots », pas ses autres enfants ni ce qu’elles lancent', () => {
    const t = parsePs(PS_MAC)
    const p = procInfoIn(t, 61002)!
    expect(p.startedAt).toBe(new Date(2026, 10, 13, 19, 28, 34).getTime())
    // Les deux zsh de l'outil Bash, et celui lancé sous le serveur MCP (deux niveaux plus bas) ; ni npm, ni vite, ni le serveur MCP.
    expect(p.shells).toHaveLength(3)
    expect(p.shells.every((c) => c.includes('shell-snapshots'))).toBe(true)
    expect(p.shells.some((c) => c.includes("eval 'npm run dev'"))).toBe(true)
    expect(procInfoIn(t, 61900)).toEqual({ startedAt: new Date(2026, 10, 13, 17, 10, 0).getTime(), shells: [] })
  })

  it('M4 procInfoIn : processus absent ou zombie → null (signal ignoré), comme sous Linux', () => {
    const t = parsePs(PS_MAC)
    expect(procInfoIn(t, 999_999)).toBeNull()
    expect(procInfoIn(t, 61510)).toBeNull()
  })

  it('M5 les règles de backgroundOf avec ce que ps a donné : commande vivante gardée, commande disparue arrêtée, travail d’avant la reprise coupé', () => {
    const t = parsePs(PS_MAC)
    const started = new Date(2026, 10, 13, 19, 28, 34).getTime()
    const launch = (at: number) => [toolUse('t1', 'Bash', { command: 'npm run dev', run_in_background: true }, at), toolResult('t1', 'bg', at, { backgroundTaskId: 'b1' })]
    // 61002 a une commande en cours : muette depuis une heure, elle tourne encore.
    const now = started + 90 * MIN
    expect(backgroundOf(file, stateOf(launch(started + 10 * MIN)), now, () => procInfoIn(t, 61002))[0].status).toBe('working')
    // 61900 n'en a aucune : sa commande lancée il y a une minute est finie.
    const old = new Date(2026, 10, 13, 17, 10, 0).getTime()
    expect(backgroundOf(file, stateOf(launch(old + 60_000)), old + 2 * MIN, () => procInfoIn(t, 61900))[0].status).toBe('stopped')
    // Lancée avant que ce claude démarre (reprise --resume) : morte avec l'ancien processus.
    expect(backgroundOf(file, stateOf(launch(started - 30 * MIN)), started + MIN, () => procInfoIn(t, 61002))[0].status).toBe('stopped')
  })

  it('M6 psProcInfo : rien tant que le premier ps n’est pas revenu, puis sa réponse ; un seul ps pour toutes les sessions', async () => {
    let now = 1_000_000
    let runs = 0
    const run = async () => (runs++, PS_MAC)
    expect(psProcInfo(61002, run, () => now)).toBeNull()
    expect(psProcInfo(61900, run, () => now)).toBeNull()
    expect(runs).toBe(1)
    await new Promise((r) => setTimeout(r, 0))
    expect(psProcInfo(61002, run, () => now)?.shells).toHaveLength(3)
    expect(psProcInfo(61900, run, () => now)?.shells).toEqual([])
    expect(psProcInfo(42, run, () => now)).toBeNull()
    expect(runs).toBe(1)
  })

  it('M7 psProcInfo : un nouveau ps au plus toutes les 5 s, lancé sans attendre (l’ancien répond en attendant)', async () => {
    let now = 1_000_000
    let runs = 0
    let out = PS_MAC
    const run = async () => (runs++, out)
    psProcInfo(61002, run, () => now)
    await new Promise((r) => setTimeout(r, 0))
    now += PS_EVERY_MS - 1
    for (let i = 0; i < 20; i++) psProcInfo(61002, run, () => now)
    expect(runs).toBe(1)
    // Les commandes sont finies : le ps suivant le dit, mais seulement une fois revenu.
    out = PS_MAC.split('\n').filter((l) => !l.includes('shell-snapshots')).join('\n')
    now += 1
    expect(psProcInfo(61002, run, () => now)?.shells).toHaveLength(3)
    expect(psProcInfo(61002, run, () => now)?.shells).toHaveLength(3)
    expect(runs).toBe(2)
    await new Promise((r) => setTimeout(r, 0))
    expect(psProcInfo(61002, run, () => now)?.shells).toEqual([])
    expect(runs).toBe(2)
  })

  it('M8 psProcInfo : ps en échec, illisible ou trop vieux (15 s) → null, jamais « plus aucune commande »', async () => {
    let now = 1_000_000
    const good = async () => PS_MAC
    psProcInfo(61002, good, () => now)
    await new Promise((r) => setTimeout(r, 0))
    expect(psProcInfo(61002, good, () => now)).not.toBeNull()
    // Un ps qui ne revient pas : la dernière réponse sert 15 s, pas plus.
    const never = () => new Promise<string>(() => undefined)
    now += PS_KEEP_MS - 1
    expect(psProcInfo(61002, never, () => now)).not.toBeNull()
    now += 1
    expect(psProcInfo(61002, never, () => now)).toBeNull()
    forgetPs()
    let failed = 0
    const fails = async () => (failed++, Promise.reject(new Error('spawn /bin/ps ENOENT')))
    expect(psProcInfo(61002, fails, () => now)).toBeNull()
    await new Promise((r) => setTimeout(r, 0))
    // Un ps qui échoue n'est pas relancé à chaque passage : au plus toutes les 5 s, comme un ps qui marche.
    for (let i = 0; i < 10; i++) {
      expect(psProcInfo(61002, fails, () => now + 100 * i)).toBeNull()
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(failed).toBe(1)
    expect(psProcInfo(61002, fails, () => now + PS_EVERY_MS)).toBeNull()
    expect(failed).toBe(2)
    forgetPs()
    // Une sortie où rien ne se lit (dates dans une autre langue) n'est pas « tous les processus ont disparu ».
    const french = async () => '61002 60990 Ss+  ven. 13 nov. 19:28:34 2026 claude\n'
    psProcInfo(61002, french, () => now)
    await new Promise((r) => setTimeout(r, 0))
    expect(psProcInfo(61002, never, () => now + 100)).toBeNull()
  })

  it('M9 procInfo : sans pid, ou sur un système qui n’est ni Linux ni macOS, null sans rien lancer', () => {
    expect(procInfo(undefined, 'darwin')).toBeNull()
    expect(procInfo(0, 'darwin')).toBeNull()
    expect(procInfo(process.pid, 'freebsd')).toBeNull()
  })

  it.skipIf(!fs.existsSync('/bin/ps'))('M10 avec le vrai /bin/ps de cette machine : même démarrage que /proc à 2 s près, mêmes commandes', async () => {
    const shell = spawn('bash', ['-c', 'sleep 30; true', '/home/u/.claude/shell-snapshots/snapshot-bash-test.sh'], { stdio: 'ignore' })
    const other = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 150))
      expect(procInfo(process.pid, 'darwin')).toBeNull() // le premier ps part, rien n'est attendu
      let p: ProcInfo | null = null
      for (let i = 0; i < 100 && !p; i++) {
        await new Promise((r) => setTimeout(r, 100))
        p = procInfo(process.pid, 'darwin')
      }
      expect(p).not.toBeNull()
      expect(p!.shells.some((c) => c.includes('snapshot-bash-test.sh'))).toBe(true)
      expect(p!.shells.every((c) => c.includes('shell-snapshots'))).toBe(true)
      expect(p!.startedAt).toBeLessThan(Date.now())
      if (process.platform === 'linux') {
        const viaProc = procInfo(process.pid, 'linux')!
        expect(Math.abs(viaProc.startedAt - p!.startedAt)).toBeLessThan(2000)
        expect(p!.shells.length).toBe(viaProc.shells.length)
      }
      expect(procInfo(999_999_999, 'darwin')).toBeNull()
    } finally {
      shell.kill()
      other.kill()
    }
  })
})

describe('détail d’un sous-agent', () => {
  it('D1 ses 12 derniers pas, lus par la fin (une ligne énorme au début n’est pas lue)', () => {
    const now = Date.now()
    const f = path.join(dir, 'subagents', 'workflows', 'wf_1', 'agent-s1.jsonl')
    const lines: unknown[] = [{ type: 'api-request-blob', timestamp: iso(now - 60 * MIN), blob: 'x'.repeat(6 << 20) }]
    for (let i = 0; i < 10; i++) {
      lines.push(subLine(now - (30 - i) * 1000, [{ type: 'text', text: `step ${i}. More words here.` }, { type: 'tool_use', name: 'Bash', input: { command: `echo ${i}`, description: `Echo ${i}` } }]))
      lines.push(subLine(now - (30 - i) * 1000 + 500, [{ type: 'tool_result', tool_use_id: `x${i}`, content: [{ type: 'text', text: `out ${i}\nline 2` }] }], 'user'))
    }
    write(f, lines)
    write(path.join(dir, 'subagents', 'workflows', 'wf_1', 'journal.jsonl'), [{ type: 'started', agentId: 's1', label: 'build', phase: 'Build' }])
    const [s] = backgroundOf(file, emptyBg(), now)
    const steps = subagentSteps(file, emptyBg(), s)
    expect(steps).toHaveLength(12)
    expect(steps.slice(-3)).toEqual([
      { at: now - 21_000, role: 'assistant', text: 'step 9. More words here.' },
      { at: now - 21_000, role: 'tool', text: 'Bash · Echo 9' },
      { at: now - 20_500, role: 'result', text: 'out 9 line 2' },
    ])
    expect(s.activity).toBe('Bash · Echo 9')
  })

  it('D2 id inconnu ou louche : aucun pas, jamais d’exception', () => {
    expect(subagentSteps(file, emptyBg(), { id: '../../etc/passwd', kind: 'agent', label: '', activity: '', status: 'done', startedAt: 0 })).toEqual([])
    expect(subagentSteps(file, emptyBg(), { id: 'nope', kind: 'step', label: '', activity: '', status: 'done', startedAt: 0 })).toEqual([])
  })
})

describe('dans le store', () => {
  it('X1 lu au fil du transcript ; un arrière-plan qui tourne se relit même quand le fil se tait depuis plus d’une heure', () => {
    const claudeDir = path.join(root, 'claude')
    const f = path.join(claudeDir, '-home-u-projects-demo', `${SID}.jsonl`)
    const now = Date.now()
    write(f, [
      { type: 'user', timestamp: iso(now - 90 * MIN), message: { role: 'user', content: 'build it' } },
      toolUse('tuw', 'Workflow', { script: "meta = { name: 'big' }" }, now - 89 * MIN),
      toolResult('tuw', 'Workflow launched in background.', now - 89 * MIN, { status: 'async_launched', taskId: 'w1', runId: 'wf_9' }),
      turnEnd(now - 89 * MIN, { workflows: 1 }),
    ])
    const sdir = path.join(f.slice(0, -'.jsonl'.length), 'subagents', 'workflows', 'wf_9')
    write(path.join(sdir, 'journal.jsonl'), [{ type: 'started', agentId: 's1', label: 'impl', phase: 'Build' }])
    write(path.join(sdir, 'agent-s1.jsonl'), [subLine(now - 88 * MIN, [{ type: 'text', text: 'working' }])])
    const store = new TranscriptStore(claudeDir, path.join(root, 'codex'), 3 * 86400_000)
    store.scan(now)
    const t = store.all()[0]
    expect(t.subagents.map((s) => [s.id, s.status, s.workflow])).toEqual([['s1', 'working', 'big']])
    // Le workflow se termine sans que le fil principal bouge (fichier inchangé) : relu quand même.
    fs.appendFileSync(path.join(sdir, 'journal.jsonl'), JSON.stringify({ type: 'result', agentId: 's1', result: 'Implemented.' }) + '\n')
    expect(store.scan(now + 1000)).toBe(true)
    // Plus d'étape en cours mais pas de fin annoncée : le workflow lui-même tourne encore (entre deux phases).
    expect(t.subagents.map((s) => [s.id, s.status, s.activity])).toEqual([
      ['wf_9', 'working', ''],
      ['s1', 'done', 'Implemented.'],
    ])
    fs.appendFileSync(f, JSON.stringify(notification('w1', 'tuw', 'completed', 'Dynamic workflow "big" completed', now + 1500)) + '\n')
    store.scan(now + 2000)
    expect(t.subagents.map((s) => [s.id, s.status])).toEqual([['s1', 'done']])
  })

  it('X3 coupé par la borne de sûreté puis réécrit, fil muet depuis plus d’une heure : relu tant que claude vit, repasse working', () => {
    const claudeDir = path.join(root, 'claude')
    const f = path.join(claudeDir, '-home-u-projects-demo', `${SID}.jsonl`)
    const now = Date.now()
    write(f, [{ type: 'user', timestamp: iso(now - 120 * MIN), message: { role: 'user', content: 'go' } }])
    const sub = path.join(f.slice(0, -'.jsonl'.length), 'subagents', 'agent-a1.jsonl')
    write(sub, [subLine(now - 119 * MIN, [{ type: 'text', text: 'long job' }])])
    writeJson(path.join(path.dirname(sub), 'agent-a1.meta.json'), { description: 'long', requestShape: 'background' })
    touch(sub, now - 30 * MIN)
    const store = new TranscriptStore(claudeDir, path.join(root, 'codex'), 3 * 86400_000)
    // pid 1 : vivant, et démarré bien avant le sous-agent (pas de « claude redémarré depuis »).
    store.pidOf = () => 1
    store.scan(now)
    const t = store.all()[0]
    expect(t.subagents.map((s) => s.status)).toEqual(['stopped'])
    fs.appendFileSync(sub, JSON.stringify(subLine(now, [{ type: 'text', text: 'back' }])) + '\n')
    store.scan(now + 1000)
    expect(t.subagents.map((s) => s.status)).toEqual(['working'])
  })

  it('X4 fin annoncée alors que la session était au repos : elle travaille dès la notification, sans passer par « idle »', () => {
    const claudeDir = path.join(root, 'claude')
    const f = path.join(claudeDir, '-home-u-projects-demo', `${SID}.jsonl`)
    const now = Date.now()
    write(f, [
      { type: 'user', timestamp: iso(now - 10 * MIN), message: { role: 'user', content: 'launch it' } },
      { type: 'assistant', timestamp: iso(now - 9 * MIN), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Launched.' }], stop_reason: 'end_turn' } },
    ])
    const store = new TranscriptStore(claudeDir, path.join(root, 'codex'), 3 * 86400_000)
    store.scan(now)
    const t = store.all()[0]
    expect(t.phase).toBe('idle')
    // Lignes réelles (082bdb66) : mise en file à .628, message qui la porte à .666, première réponse 3 s plus tard.
    fs.appendFileSync(f, JSON.stringify(notification('w1', 'tuw', 'completed', 'Dynamic workflow "big" completed', now)) + '\n')
    store.scan(now + 10)
    expect([t.phase, t.workStartedAt]).toEqual(['working', now])
    fs.appendFileSync(f, JSON.stringify({ type: 'user', timestamp: iso(now + 40), message: { role: 'user', content: '<task-notification>\n<task-id>w1</task-id>\n<status>completed</status>\n</task-notification>' } }) + '\n')
    store.scan(now + 50)
    expect(t.phase).toBe('working')
  })

  it('X2 lignes illisibles, champs absents, types inattendus : ignorés sans planter', () => {
    const bg = emptyBg()
    for (const o of [null, 1, 'x', {}, { type: 'assistant' }, { type: 'assistant', message: { content: [null, { type: 'tool_use' }] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'nope' }] } }, { type: 'queue-operation', operation: 'enqueue', content: '<task-notification><status>completed' }, { type: 'system', subtype: 'turn_duration', pendingWorkflowCount: 'two' }])
      expect(() => bgLine(bg, o, 0)).not.toThrow()
    expect(() => backgroundOf(path.join(root, 'missing.jsonl'), bg, Date.now())).not.toThrow()
  })
})

describe('jobs started into a logs folder, and plain names (r47)', () => {
  it('J1 the log names a command writes in a logs folder, not the ones it only reads', () => {
    expect(logJobsIn('cd ~/projects/weevils && nohup node scripts/mock.mjs > ~/logs/get-host-mock.log 2>&1 &')).toEqual(['get-host-mock'])
    expect(logJobsIn('npx playwright test >> $HOME/logs/pw-webkit.log 2>&1')).toEqual(['pw-webkit'])
    expect(logJobsIn('node x.mjs 2>&1 | tee -a /home/u/logs/get-flow-phone.log')).toEqual(['get-flow-phone'])
    expect(logJobsIn('node x > "/home/u/.local/share/weevils/jobs/e2e-pc.log"')).toEqual(['e2e-pc'])
    expect(logJobsIn('tail -n 40 ~/logs/get-host-mock.log; grep -q done ~/logs/a.log')).toEqual([])
    expect(logJobsIn('nohup node w.mjs > ~/.local/share/weevils/jobs/night.log 2>&1 &')).toEqual(['night'])
    expect(logJobsIn('node w.mjs >> ${HOME}/logs/a.log; node v.mjs > $HOME/x/jobs/b.log')).toEqual(['a', 'b'])
    expect(logJobsIn('node w.mjs > /tmp/out.log; echo ok > ~/notes/logs.txt')).toEqual([])
  })

  it('J2 a nohup job is remembered with the agent’s description; without one, a catalog word, never the command', () => {
    const now = Date.now()
    const bg = stateOf([
      toolUse('j1', 'Bash', { command: 'nohup node mock.mjs > ~/logs/get-host-mock.log 2>&1 &', description: 'Start the host mock' }, now - 5 * MIN),
      toolUse('j2', 'Bash', { command: 'nohup npx playwright test --project=webkit > ~/logs/pw-webkit.log 2>&1 &' }, now - 4 * MIN),
      toolUse('j3', 'Bash', { command: 'sleep 400', run_in_background: true }, now - 3 * MIN),
    ])
    expect(bg.logJobs).toEqual({ 'get-host-mock': { label: 'Start the host mock', at: now - 5 * MIN }, 'pw-webkit': { label: shellLabel('', 'playwright test'), at: now - 4 * MIN } })
    const shell = backgroundOf(file, bg, now).find((x) => x.kind === 'shell')!
    expect(shell.label).toBe(shellLabel('', 'sleep 400'))
    expect(shell.label).not.toContain('sleep')
    expect(shellLabel('', 'npx vitest run')).not.toBe(shellLabel('', 'sleep 1'))
    expect(shellLabel('', 'pnpm test')).toBe(shellLabel('', 'npx vitest run'))
    // The word alone is not a test run: « test -f », a path under test/.
    expect(shellLabel('', 'test -f a && node serve.mjs')).toBe(shellLabel('', 'sleep 1'))
    expect(shellLabel('', 'node src/test/serve.mjs')).toBe(shellLabel('', 'sleep 1'))
  })
})
