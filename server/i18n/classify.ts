// Messages of server/classify.ts: why a conversation went to a project, and the prompt of the LLM judge.
// Both languages ask for the reason in the user's language.
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    /** Reason shown under a conversation sorted by the rules (a project or repo name appears in it). */
    ruleReason: (term: string) => `« ${term} » apparaît dans l’échange`,
    intro: (user: string) => `Tu ranges des conversations (ChatGPT, Claude) dans les projets de ${user}. Ne lis aucun fichier, ne lance aucune commande : réponds directement.`,
    destinations:
      'Les seules destinations possibles sont les projets ci-dessous (id : nom · repos · description). Un thème (« design », « argent », « santé ») n’est pas un projet : n’invente jamais de catégorie.',
    project: (id: string, name: string, repos: string, about: string) => `- ${id} : ${name}${repos ? ` · ${repos}` : ''}${about ? ` · ${about}` : ''}`,
    examples: (user: string, lines: string) => `\nRangements validés par ${user} (à imiter) :\n${lines}`,
    example: (title: string, projectId: string) => `- « ${title} » → ${projectId}`,
    task: (user: string) =>
      [
        `Pour chaque conversation, lis l’extrait (premiers messages de ${user}, puis la fin) et juge de quoi elle parle vraiment :`,
        `- project = l’id d’un projet de la liste dont la conversation relève clairement, sinon null. Dans le doute, null : ${user} tranchera.`,
        '- confidence entre 0 et 1 (≥ 0.7 seulement si c’est évident) ; reason = une phrase courte en français qui cite l’indice décisif.',
      ].join('\n'),
    conversations: 'Conversations :',
    /** One conversation of the prompt, as JSON (keys in the prompt's language). */
    item: (id: string, title: string, excerpt: string) => JSON.stringify({ id, titre: title, extrait: excerpt }),
  },
  en: {
    ruleReason: (term: string) => `"${term}" comes up in the conversation`,
    intro: (user: string) => `You sort conversations (ChatGPT, Claude) into ${user}'s projects. Don't read any file, don't run any command: answer directly.`,
    destinations:
      'The only possible destinations are the projects below (id: name · repos · description). A theme ("design", "money", "health") is not a project: never invent a category.',
    project: (id: string, name: string, repos: string, about: string) => `- ${id}: ${name}${repos ? ` · ${repos}` : ''}${about ? ` · ${about}` : ''}`,
    examples: (user: string, lines: string) => `\nAlready sorted by ${user} (do the same):\n${lines}`,
    example: (title: string, projectId: string) => `- "${title}" → ${projectId}`,
    task: (user: string) =>
      [
        `For each conversation, read the excerpt (${user}'s first messages, then the end) and judge what it is really about:`,
        `- project = the id of a project in the list the conversation clearly belongs to, otherwise null. When in doubt, null: ${user} will decide.`,
        '- confidence between 0 and 1 (≥ 0.7 only if it is obvious); reason = one short sentence in English that quotes the decisive clue.',
      ].join('\n'),
    conversations: 'Conversations:',
    item: (id: string, title: string, excerpt: string) => JSON.stringify({ id, title, excerpt }),
  },
})
