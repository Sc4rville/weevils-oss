// Messages of the live voice mode (src/ui/voice.tsx, src/live.ts): a calm line under weevboss's logo.
import { defineMessages } from './index'

export default defineMessages({
  fr: {
    /** aria-label of the logo while live. */
    stop: 'terminer la conversation en direct',
    /** The small line under the logo: « direct · 1:12 · 0,8 ¢ ». */
    live: 'direct',
    connecting: 'connexion…',
    thinking: 'weevboss s’en occupe',
    /** Why a live conversation ended or could not start. */
    nokey: 'pour parler en direct, ajoute ta clé Gemini',
    billing: 'crédits Gemini épuisés : recharge-les dans Google AI Studio',
    quota: 'Gemini est à sa limite pour l’instant, réessaie plus tard',
    auth: 'Gemini refuse la clé : recolle-la',
    model: 'ce modèle Gemini Live n’est pas disponible',
    upstream: 'la conversation en direct a été coupée',
    nohere: 'le direct marche sur la machine de weevboss',
    silence: 'direct terminé après 2 minutes de silence',
    limit: 'direct terminé après 30 minutes',
    mic: 'micro refusé',
    /** Session summary after it ends: « 3:12 · 4,1 ¢ ». */
    summary: (time: string, cost: string) => `direct terminé · ${time} · ${cost}`,
  },
  en: {
    stop: 'end the live conversation',
    live: 'live',
    connecting: 'connecting…',
    thinking: 'weevboss is on it',
    nokey: 'to talk live, add your Gemini key',
    billing: 'Gemini credits are used up: top them up in Google AI Studio',
    quota: 'Gemini is at its limit for now, try again later',
    auth: 'Gemini refused the key: paste it again',
    model: 'this Gemini Live model isn’t available',
    upstream: 'the live conversation dropped',
    nohere: 'live works on weevboss’s machine',
    silence: 'live ended after 2 minutes of silence',
    limit: 'live ended after 30 minutes',
    mic: 'microphone refused',
    summary: (time: string, cost: string) => `live ended · ${time} · ${cost}`,
  },
})
