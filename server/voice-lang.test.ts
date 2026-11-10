// La voix de weevboss parle la langue du message, jamais celle d'un réglage global :
// ici la langue réglée est l'anglais (ce qu'un navigateur anglais avait imposé), et l'utilisateur écrit en français.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./i18n.ts', async (orig) => ({ ...(await orig<typeof import('./i18n.ts')>()), lang: () => 'en' as const }))

process.env.OPENAI_API_KEY = 'test'
process.env.CARTESIA_API_KEY = 'test'
process.env.CARTESIA_VOICE_ID = 'zoe'

const { speakStream, langOf } = await import('./voicepipe.ts')
const { cartesiaStream } = await import('./fast.ts')

type Call = { url: string; body: any }
let calls: Call[]

const sse = (text: string) =>
  new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`)); c.close() } }))
const mp3 = () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([0xff, 0xfb, 0x90, 0x00])); c.close() } }))

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ url: String(url), body })
    if (String(url).includes('openai.com')) return sse('Les deux sessions tournent, rien de bloqué.')
    return mp3()
  })
})
afterEach(() => vi.unstubAllGlobals())

const fakeRes = () => {
  const out: Uint8Array[] = []
  return { writeHead: () => {}, write: (b: Uint8Array) => (out.push(b), true), end: () => {}, out } as any
}

describe('voix : la langue suit le message', () => {
  it('réponse française de weevboss, réglage en anglais : résumé demandé en français, Cartesia en français', async () => {
    const reply =
      "J'ai relancé le build de mygame dans la session weevils-3f2a, puis j'ai vérifié server/core.ts : les deux sessions tournent et rien n'est bloqué pour l'instant, je te préviens dès que c'est fini."
    await speakStream(fakeRes(), reply, false)
    const summary = calls.find((c) => c.url.includes('openai.com'))!
    expect(summary.body.messages[0].content).toMatch(/en français/)
    const tts = calls.filter((c) => c.url.includes('cartesia.ai/tts'))
    expect(tts.length).toBeGreaterThan(0)
    for (const c of tts) {
      expect(c.body.language).toBe('fr')
      expect(c.body.voice.id).toBe('zoe')
    }
  })

  it('réponse courte lue telle quelle : en français aussi', async () => {
    await speakStream(fakeRes(), 'Ok, je regarde ça tout de suite.', false)
    expect(calls.filter((c) => c.url.includes('openai.com'))).toHaveLength(0)
    expect(calls.find((c) => c.url.includes('cartesia.ai/tts'))!.body.language).toBe('fr')
  })

  it('une réponse anglaise reste en anglais', async () => {
    await cartesiaStream("I'm on it, the build is running.", 'zoe')
    expect(calls[0].body.language).toBe('en')
  })

  it('texte indécidable : la langue réglée', () => {
    expect(langOf('npm run build')).toBe('en')
  })
})
