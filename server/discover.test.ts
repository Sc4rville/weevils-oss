import { describe, expect, it, vi } from 'vitest'
import { macFacts, macLaptop, sshdPort } from './discover.ts'

// Les faits d'un Mac (server/discover.ts), vérifiés sur Linux : ce que les commandes répondent est donné ici.
const BATTERY = `Now drawing from 'AC Power'\n -InternalBattery-0 (id=23658595)\t100%; charged; 0:00 remaining present: true\n`
const NO_BATTERY = `Now drawing from 'AC Power'\n`

describe('a Mac laptop or not', () => {
  it('a battery makes a laptop, whatever the model is called (no « Book » in the names since 2022)', () => {
    const table: [model: string, batt: string, laptop: boolean][] = [
      ['MacBookPro16,1', BATTERY, true],
      ['Mac14,2', BATTERY, true], // MacBook Air M2
      ['Mac14,3', NO_BATTERY, false], // Mac mini M2
      ['Mac15,3', BATTERY, true],
      ['iMac21,1', NO_BATTERY, false],
      ['VirtualMac2,1', NO_BATTERY, false],
      // pmset did not answer: an older model name still tells.
      ['MacBookAir10,1', '', true],
      ['Mac14,2', '', false],
    ]
    for (const [model, batt, laptop] of table) expect(macLaptop(model, batt), model).toBe(laptop)
  })
  it('reads the model and the battery, and stays quiet when the commands fail', async () => {
    const exec = (model: string, batt: string) => async (cmd: string) => (cmd.endsWith('sysctl') ? model : cmd.endsWith('pmset') ? batt : '')
    expect(await macFacts(exec('Mac14,2', BATTERY))).toEqual({ hardware: 'Apple Mac14,2', laptop: true })
    expect(await macFacts(exec('Mac14,3', NO_BATTERY))).toEqual({ hardware: 'Apple Mac14,3', laptop: false })
    expect(await macFacts(exec('', ''))).toEqual({ hardware: undefined, laptop: false })
  })
})

describe('sshd port', () => {
  const sshd = (f: string) => f === '/usr/sbin/sshd'
  it('on a Mac, only when something listens (sshd is on every Mac, Remote Login is off by default)', async () => {
    const closed = vi.fn(async () => false)
    expect(await sshdPort('darwin', closed, sshd)).toBeUndefined()
    expect(closed).toHaveBeenCalledTimes(1)
    const port = await sshdPort('darwin', async () => true, sshd)
    expect(port).toBeGreaterThan(0)
    expect(closed.mock.calls[0]).toEqual([port])
  })
  it('on Linux, as before: the configured port, nothing probed; none without sshd', async () => {
    const probe = vi.fn(async () => false)
    expect(await sshdPort('linux', probe, sshd)).toBeGreaterThan(0)
    expect(await sshdPort('linux', probe, () => false)).toBeUndefined()
    expect(await sshdPort('darwin', probe, () => false)).toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
  })
})
