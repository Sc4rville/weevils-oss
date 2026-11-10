// Messages of src/ui/voice.tsx: weevboss's voice button and the voice picker.
import { defineMessages } from './index'

export default defineMessages({
  fr: {
    readAudio: 'lecture audio impossible',
    nothingHeard: 'rien entendu',
    micDenied: 'micro refusé',
    /** Label of the logo button, by phase: idle, recording, transcribing, ready to send. */
    dictate: 'dicter à weevboss',
    stopAndTranscribe: 'arrêter et transcrire',
    sendWhenReady: 'envoyer dès que transcrit',
    send: 'envoyer',
    /** Sample sentence said when a voice is picked. */
    hello: (name: string) => `Salut${name ? ` ${name}` : ''}, c’est moi, weevboss.`,
    voices: 'voix',
  },
  en: {
    readAudio: 'couldn’t read the audio',
    nothingHeard: 'didn’t hear anything',
    micDenied: 'mic blocked',
    dictate: 'talk to weevboss',
    stopAndTranscribe: 'stop and transcribe',
    sendWhenReady: 'send once transcribed',
    send: 'send',
    hello: (name: string) => `Hi${name ? ` ${name}` : ''}, it’s me, weevboss.`,
    voices: 'voices',
  },
})
