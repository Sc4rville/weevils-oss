// Messages of server/titles.ts: the prompt that names sessions. Both languages ask for titles in the user's language.
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    prompt: (user: string, sessions: string) =>
      [
        `Tu nommes des sessions d’agents de code (Claude Code, Codex) pour que ${user} comprenne d’un coup d’œil, sur son téléphone, de quoi chacune parle. Ne lis aucun fichier, ne lance aucune commande : réponds directement.`,
        '',
        'Pour chaque session, à partir de son début et de ses derniers échanges :',
        '- title : le THÈME de la session, ce sur quoi on bosse dedans, en français, 2 à 5 mots, très court, style note perso (ex. « UX de weevils », « code d’accès iPhone », « perf du jeu », « mails prospects »). Sans point final, sans guillemets, sans « session » ni « conversation », jamais le premier message mot pour mot. Un titre stable : si le thème général n’a pas changé, garde le même esprit.',
        '- now : la dernière chose faite ou en cours, ≤ 5 mots et ≤ 40 caractères (elle doit tenir sur une ligne de téléphone), en français, au présent, sans sujet (ex. « corrige le détecteur d’écran », « déploie sur le VPS »).',
        'Si les derniers échanges partent sur un autre thème que le début, c’est le nouveau thème qui compte.',
        '',
        'Sessions :',
        sessions,
      ].join('\n'),
    /** One session of the prompt, as JSON (keys in the prompt's language). */
    item: (id: string, tool: string, where: string, start: string, recent: string[]) =>
      JSON.stringify({ id, outil: tool, ou: where, debut: start, derniers_echanges: recent }),
    /** Without Codex (no output schema): the answer format, said in the prompt. */
    jsonOnly: 'Réponds uniquement avec ce JSON, sans rien autour : {"items":[{"id":"…","title":"…","now":"…"}]}',
  },
  en: {
    prompt: (user: string, sessions: string) =>
      [
        `You name coding-agent sessions (Claude Code, Codex) so that ${user} can tell at a glance, on their phone, what each one is about. Don't read any file, don't run any command: answer directly.`,
        '',
        'For each session, from its beginning and its latest exchanges:',
        '- title: the TOPIC of the session, what is being worked on, in English, 2 to 5 words, very short, like a personal note (e.g. "weevils UX", "iPhone passcode", "game perf", "prospect emails"). No final period, no quotes, no "session" or "conversation", never the first message word for word. A stable title: if the overall topic has not changed, keep the same spirit.',
        '- now: the last thing done or in progress, ≤ 5 words and ≤ 40 characters (it must fit on one phone line), in English, present tense, no subject (e.g. "fixes the screen detector", "deploys to the VPS").',
        'If the latest exchanges drift to a different topic from the beginning, the new topic is what counts.',
        '',
        'Sessions:',
        sessions,
      ].join('\n'),
    item: (id: string, tool: string, where: string, start: string, recent: string[]) =>
      JSON.stringify({ id, tool, where, start, latest_exchanges: recent }),
    jsonOnly: 'Answer with this JSON only, nothing around it: {"items":[{"id":"…","title":"…","now":"…"}]}',
  },
})
