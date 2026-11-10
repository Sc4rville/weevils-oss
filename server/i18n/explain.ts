// Prompts of the quick questions (server/explain.ts) on a file, a thread or the memory page: explain a word, say where it's
// used, answer a question.
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
    /** Head for the memory page: one memory item (where it came from), a few others, the selection. */
    headMemory: (user: string, text: string, q: string, a: string, others: string, sel: string) =>
      `Tu es weevboss, l'assistant de ${user}. weevils garde une petite mémoire de ${user} (ses objectifs, ses envies, ses projets, ses goûts), tirée de ses réponses aux petites questions du weevil ou notée à la main. Elle sert à lui poser des questions de plus en plus justes, à lui proposer des tâches de fond quand ses agents ne travaillent pas (la bande auto) et à toi, pour le connaître. Elle reste sur sa machine et ne part qu'au modèle.\n\n` +
      `Il relit sur son téléphone ce souvenir : « ${text} »\n` +
      (q ? `Il vient de sa réponse à la question « ${q} »${a ? ` : « ${a} »` : ''}.\n` : `Il l'a noté (ou corrigé) à la main.\n`) +
      (others ? `\nSes autres souvenirs :\n${others}\n` : '') +
      (sel ? `\nIl a sélectionné : « ${sel} »\n\n` : '\n'),
    /** Head for the memory page when no item is open: the whole memory. */
    headMemoryAll: (user: string, all: string, sel: string) =>
      `Tu es weevboss, l'assistant de ${user}. weevils garde une petite mémoire de ${user} (ses objectifs, ses envies, ses projets, ses goûts), tirée de ses réponses aux questions du weevil ou notée à la main ; elle sert à lui poser de meilleures questions, à lui proposer des tâches de fond (la bande auto) et à toi, pour le connaître. Il la relit sur son téléphone :\n${all || '(vide)'}\n\n` +
      (sel ? `Il a sélectionné : « ${sel} »\n\n` : ''),
    explainMemory:
      'Parle-lui directement, en le tutoyant : dis ce que ça veut dire pour lui, pourquoi weevils l’a retenu et à quoi ça va servir, en une à trois phrases courtes en français, en langage humain. Pas de titre, pas de liste, pas de markdown, ne récite pas le souvenir.',
    forwardMemory: (text: string, id: string, sel: string, q: string) =>
      `[depuis la page mémoire${text ? `, souvenir ${id} « ${text} »` : ''}${sel ? `, sélection « ${sel} »` : ''}]\n${q}`,
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
    headMemory: (user: string, text: string, q: string, a: string, others: string, sel: string) =>
      `You are weevboss, ${user}'s assistant. weevils keeps a small memory of ${user} (their goals, wishes, projects, tastes), drawn from their answers to the weevil's little questions or written down by hand. It is used to ask them sharper and sharper questions, to suggest background tasks while their agents are idle (the auto band), and by you, to know them. It stays on their machine and only ever goes to the model.\n\n` +
      `They are reading this memory on their phone: "${text}"\n` +
      (q ? `It comes from their answer to the question "${q}"${a ? `: "${a}"` : ''}.\n` : `They wrote (or corrected) it by hand.\n`) +
      (others ? `\nTheir other memories:\n${others}\n` : '') +
      (sel ? `\nThey selected: "${sel}"\n\n` : '\n'),
    headMemoryAll: (user: string, all: string, sel: string) =>
      `You are weevboss, ${user}'s assistant. weevils keeps a small memory of ${user} (their goals, wishes, projects, tastes), drawn from their answers to the weevil's questions or written down by hand; it is used to ask them better questions, to suggest background tasks (the auto band), and by you, to know them. They are reading it on their phone:\n${all || '(empty)'}\n\n` +
      (sel ? `They selected: "${sel}"\n\n` : ''),
    explainMemory:
      'Talk to them directly: say what it means for them, why weevils kept it and what it will be used for, in one to three short sentences in English, plain human language. No heading, no list, no markdown, don’t recite the memory.',
    forwardMemory: (text: string, id: string, sel: string, q: string) =>
      `[from the memory page${text ? `, memory ${id} "${text}"` : ''}${sel ? `, selection "${sel}"` : ''}]\n${q}`,
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
