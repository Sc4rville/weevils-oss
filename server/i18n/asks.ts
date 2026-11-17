// Messages of server/asks-judge.ts: the prompt that decides whether a session's last words ask the human something.
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    prompt: (user: string, session: string, where: string, message: string) =>
      [
        `Tu tries les messages d’agents de code (Claude Code, Codex) pour ${user}. Ne lis aucun fichier, ne lance aucune commande : réponds directement.`,
        `Session « ${session} » (${where}). Fin de son dernier message :`,
        '"""',
        message,
        '"""',
        `real vaut true SEULEMENT si l’agent attend une vraie décision ou une vraie information de ${user} pour continuer (un choix, un accord, une valeur, un lien à ouvrir). false pour un compte rendu, un état en cours, une question rhétorique, un tableau ou du texte technique ou cassé, une question à un autre agent. Dans le doute : false.`,
        'Si real vaut true, question : une seule phrase claire en français, compréhensible sans le fil, qui nomme la session et ce qu’elle veut savoir, avec les choix s’il y en a (ex. « La session TLO veut savoir si elle peut dépenser 2 $ de GPU : oui / non »). Sinon question vaut "".',
        'Réponds uniquement avec ce JSON, sans rien autour : {"real":true,"question":"…"}',
      ].join('\n'),
  },
  en: {
    prompt: (user: string, session: string, where: string, message: string) =>
      [
        `You sort coding agents' messages (Claude Code, Codex) for ${user}. Read no file, run no command: answer directly.`,
        `Session “${session}” (${where}). End of its last message:`,
        '"""',
        message,
        '"""',
        `real is true ONLY if the agent waits for a real decision or a real piece of information from ${user} to go on (a choice, an approval, a value, a link to open). false for a report, a transient state, a rhetorical question, a table or technical or broken text, a question to another agent. When in doubt: false.`,
        'If real is true, question: one clear sentence in English, understandable without the thread, naming the session and what it wants to know, with the choices if any (e.g. “The TLO session wants to know whether it may spend $2 of GPU: yes / no”). Otherwise question is "".',
        'Answer with this JSON only, nothing around it: {"real":true,"question":"…"}',
      ].join('\n'),
  },
})
