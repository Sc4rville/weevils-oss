// Prompts of the file explorer's quick questions (server/explain.ts): explain a word, say where it's used, answer a question.
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    /** Shared head of every prompt: who answers, the page, the lines around (numbered), the selection. */
    head: (user: string, repo: string, path: string, around: string, sel: string, from: number, to: number) =>
      `Tu es weevboss, l'assistant de ${user}. Il lit le fichier ${path} du repo ${repo} sur son téléphone.\n\nLignes autour (numérotées) :\n${around}\n\n` +
      (sel ? `Il a sélectionné, ligne${from === to ? ` ${from}` : `s ${from} à ${to}`} : « ${sel} »\n\n` : `Rien n'est sélectionné : il regarde les lignes ${from} à ${to}.\n\n`),
    /** Head for a conversation thread: the session (title, tool, project, repo), the messages around, the selection. */
    headConv: (user: string, title: string, tool: string, project: string, repo: string, around: string, sel: string) =>
      `Tu es weevboss, l'assistant de ${user}. Il lit sur son téléphone la conversation « ${title} » avec ${tool}${project ? `, projet ${project}` : ''}${repo ? `, repo ${repo}` : ''}.\n\nMessages autour :\n${around}\n\n` +
      (sel ? `Il a sélectionné : « ${sel} »\n\n` : `Rien n'est sélectionné : il regarde ces messages.\n\n`),
    forwardConv: (title: string, sel: string, q: string) => `[depuis la conversation « ${title} »${sel ? `, sélection « ${sel} »` : ''}]\n${q}`,
    explain:
      'Explique ce que c’est et à quoi ça sert ici, en langage humain, en une à trois phrases courtes en français. Pas de titre, pas de liste, pas de markdown, pas de reformulation de la question.',
    usage: (hits: string) =>
      `Voici où ça apparaît dans le repo (fichier:ligne: texte) :\n${hits || '(nulle part ailleurs)'}\n\nDis en une ou deux phrases courtes en français où et comment c’est utilisé. Pas de liste, pas de markdown.`,
    ask: (q: string) =>
      `Sa question : « ${q} »\n\nSi c’est une question, réponds en une à quatre phrases courtes en français, en langage humain, sans markdown. Si c’est une demande d’action (modifier, corriger, lancer, créer, supprimer, envoyer…) et pas une question, réponds exactement ${ACTION} et rien d’autre.`,
    /** Prefix of a request forwarded to the real weevboss, so he knows the page. */
    forward: (repo: string, path: string, from: number, to: number, sel: string, q: string) =>
      `[depuis la page fichier ${repo}/${path}, ligne${from === to ? ` ${from}` : `s ${from}-${to}`}${sel ? `, sélection « ${sel} »` : ''}]\n${q}`,
  },
  en: {
    head: (user: string, repo: string, path: string, around: string, sel: string, from: number, to: number) =>
      `You are weevboss, ${user}'s assistant. They are reading the file ${path} of the repo ${repo} on their phone.\n\nLines around (numbered):\n${around}\n\n` +
      (sel ? `They selected, line${from === to ? ` ${from}` : `s ${from} to ${to}`}: "${sel}"\n\n` : `Nothing is selected: they are looking at lines ${from} to ${to}.\n\n`),
    headConv: (user: string, title: string, tool: string, project: string, repo: string, around: string, sel: string) =>
      `You are weevboss, ${user}'s assistant. They are reading, on their phone, the conversation "${title}" with ${tool}${project ? `, project ${project}` : ''}${repo ? `, repo ${repo}` : ''}.\n\nMessages around:\n${around}\n\n` +
      (sel ? `They selected: "${sel}"\n\n` : `Nothing is selected: they are looking at these messages.\n\n`),
    forwardConv: (title: string, sel: string, q: string) => `[from the conversation "${title}"${sel ? `, selection "${sel}"` : ''}]\n${q}`,
    explain:
      'Explain what it is and what it does here, in plain human language, in one to three short sentences in English. No heading, no list, no markdown, don’t restate the question.',
    usage: (hits: string) =>
      `Here is where it appears in the repo (file:line: text):\n${hits || '(nowhere else)'}\n\nSay in one or two short sentences in English where and how it is used. No list, no markdown.`,
    ask: (q: string) =>
      `Their question: "${q}"\n\nIf it is a question, answer in one to four short sentences in English, plain human language, no markdown. If it is a request for an action (change, fix, run, create, delete, send…) rather than a question, reply exactly ${ACTION} and nothing else.`,
    forward: (repo: string, path: string, from: number, to: number, sel: string, q: string) =>
      `[from the file page ${repo}/${path}, line${from === to ? ` ${from}` : `s ${from}-${to}`}${sel ? `, selection "${sel}"` : ''}]\n${q}`,
  },
})

/** Haiku's answer when the question is really an order for weevboss. */
export const ACTION = '@@ACTION@@'
