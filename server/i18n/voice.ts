// Messages of weevboss's voice (server/voicepipe.ts, server/transcribe.ts, server/fast.ts): the spoken-summary
// prompt, the short cues played while weevboss works, what Siri hears, and the errors shown in the app.
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    /** Prompt of the spoken summary (gpt-4o-mini, haiku as fallback). The message to summarize follows it. */
    oral: (user: string) =>
      `Résume ce message pour le dire à voix haute à ${user}, en une ou deux phrases courtes en français, parlé, comme un pote. Dis ce qui a été fait ou ce qui se passe. Aucun identifiant, chemin, nom de fichier, commande ni liste. Réponds seulement avec la phrase à dire.`,
    /** Said instead of a URL. */
    aLink: 'un lien',
    /** Short cues played the moment a voice message is sent, one per line (synthesized once, then cached). */
    cues: 'Ok.\nJe regarde.\nÇa marche.\nJe m’en occupe.',
    /** Siri: the user ends the conversation (« stop », « merci »…). */
    bye: 'À plus.',
    /** Siri: weevboss hasn't answered yet. */
    stillWorking: 'C’est parti, il y travaille encore.',
    nothingHeard: 'rien entendu',
    badRecording: 'enregistrement invalide',
    recordingNotFound: 'enregistrement introuvable',
    missingAudio: 'audio manquant',
    transcriptionOff: 'transcription non configurée sur le serveur',
    transcriptionError: (status: number) => `transcription : erreur ${status}`,
    noCartesiaKey: 'clé Cartesia absente',
    noCartesiaVoice: 'aucune voix française Cartesia',
    /** edge-tts (free voice) is not installed: say how to install it. */
    noEdgeTts: 'voix indisponible : edge-tts n’est pas installé (pipx install edge-tts)',
  },
  en: {
    oral: (user: string) =>
      `Sum up this message so it can be said out loud to ${user}, in one or two short spoken sentences in English, casual, like a friend. Say what was done or what is going on. No ids, paths, file names, commands or lists. Reply with the sentence to say and nothing else.`,
    aLink: 'a link',
    cues: 'Ok.\nLet me look.\nOn it.\nI’ll take care of it.',
    bye: 'See you.',
    stillWorking: 'On it, still working.',
    nothingHeard: 'didn’t hear anything',
    badRecording: 'invalid recording',
    recordingNotFound: 'recording not found',
    missingAudio: 'no audio',
    transcriptionOff: 'transcription isn’t set up on the server',
    transcriptionError: (status: number) => `transcription: error ${status}`,
    noCartesiaKey: 'no Cartesia key',
    noCartesiaVoice: 'no English Cartesia voice',
    noEdgeTts: 'no voice: edge-tts isn’t installed (pipx install edge-tts)',
  },
})
