// The « for you » stream (server/foryou.ts): the one-line texts of what weevilsd computes itself (alerts, a cut
// session, the proposals band), the reasons of a refused request, and the hidden notes that go to weevboss with a
// tap or a reply. The curator's prompts (generated items) will live here too.
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    intentAmbiguous: 'Plusieurs travaux correspondent. Ouvre la conversation concernée pour préciser lequel, sans relancer la demande.',
    intentUncertain: 'La réception de cette demande reste incertaine. Vérifie la conversation existante avant de la renvoyer.',
    followWork: 'Voir le travail existant',
    invalidVisual: 'proposition visuelle invalide ou destination indisponible',
    // ---- refused requests (shown as is by the app and by « weevils post / show »)
    notFound: 'ce n’est plus dans le flux',
    localOnly: 'réservé à cette machine',
    emptyText: 'rien à dire',
    technicalPost: 'publie le résultat utile, pas le journal technique',
    noReply: 'on ne peut pas répondre à ça',
    noAction: 'ce bouton n’existe plus',
    cardGone: 'cette proposition n’est plus là',
    mailOff: 'le mail n’est pas branché',
    noMore: 'rien de plus là-dessus pour l’instant',
    noMedia: 'les images et vidéos ne sont pas disponibles ici',
    // ---- sessions
    /** A session waits for the user and its tool gave no question. */
    waiting: 'J’ai besoin de toi pour continuer.',
    /** A finished session whose closing words give no whole sentence to show (only code, paths) and no title yet. */
    resultUntitled: 'Terminé. Ouvre pour lire ce qui a été fait.',
    /** A session cut off mid-work; `why` comes from the core catalog (cutWhy). */
    cut: (why: string) => `Aïe, on m’a coupé en plein travail (${why}). Tu me relances ?`,
    resume: 'Reprendre',
    // ---- quota pace (an insight: a trend and its consequence)
    paceOut: (tool: string, used: number, gone: number, hours: number) => `${tool} : ${used} % de la semaine utilisés en ${gone} % du temps. À ce rythme, plus rien ~${hours} h avant la remise à zéro.`,
    paceRoom: (tool: string, used: number, days: number) => `${tool} : seulement ${used} % de la semaine utilisés, ${days} j avant la remise à zéro. De la place pour un gros chantier.`,
    // ---- alerts (one sober line each)
    usage: (tool: string, window: string, percent: number, spare: string) =>
      `T’es à ${percent} % de ta ${window} ${tool}. ${spare ? `Je garde ${spare} au chaud au cas où.` : 'Je lève le pied sur ce qui peut attendre.'}`,
    window_session: 'fenêtre de 5 h',
    window_week: 'semaine',
    window_model: (label: string) => `semaine ${label}`,
    saturated: (machine: string) => `${machine} est à bout de souffle, j’évite de lui en rajouter.`,
    diskFull: (machine: string, percent: number) => `Le disque de ${machine} est plein à ${percent} %, faudrait faire un peu de ménage.`,
    offline: (machine: string) => `Je n’arrive plus à joindre ${machine}.`,
    autoFailed: (title: string, note: string) => `L’automatisation « ${title} » s’est plantée${note ? ` (${note})` : ''}. On retente ou on laisse tomber ?`,
    // ---- proposals
    deployed: (hash: string) => `La version ${hash} de weevils est en ligne. Tu peux la retrouver ici.`,
    commit: (repo: string, hash: string, subject: string) => `${repo} a un nouveau commit (${hash}) : ${subject}`,
    autoProposed: (title: string) => `J’ai une idée pour toi : « ${title} ». Tu peux la retrouver dans les propositions.`,
    /** An auto task that carries out what the user said themselves: never passed off as weevils' idea. */
    autoOwn: (title: string) => `Ton idée, prête à lancer : « ${title} ». Elle t’attend dans les propositions.`,
    ownWhy: 'Ton idée, prête à lancer.',
    ownProposals: (n: number) => (n > 1 ? `Tes ${n} idées sont prêtes à lancer` : 'Ton idée est prête à lancer'),
    autoGo: (title: string) => `J’ai lancé l’automatisation « ${title} » pendant que la machine souffle un peu.`,
    autoDone: (title: string, note: string) => `L’automatisation « ${title} » est bouclée${note ? ` : ${note}` : '.'}`,
    proposals: (n: number) => (n > 1 ? `J’ai ${n} idées pour toi` : 'J’ai une idée pour toi'),
    // ---- what weevboss receives
    /** The visible message of a tapped button under a post. */
    go: (label: string) => `Vas-y : ${label}`,
    /** Hidden note joined to that message (never shown in the thread). */
    actBrief: (post: string, brief: string) => `l'utilisateur a touché ce bouton sous ton mot dans son flux « pour toi » (« ${post} »). À faire : ${brief}`,
    /** Hidden note joined to a reply typed under a post. */
    replyBrief: (post: string) => `réponds au message ci-dessus : l'utilisateur l'a écrit dans son flux « pour toi », en réponse à ton mot « ${post} »`,
    /** The prompt that titles a session result card (a light model reads the whole closing message). */
    resultTitle: (project: string, asked: string, text: string) =>
      `Voici le compte rendu de fin de tour d'un agent de code qui travaille sur le projet « ${project} »${asked ? ` ; l'utilisateur lui avait demandé : ${asked}` : ''}.\n\nCompte rendu :\n${text}\n\n` +
      `Écris le titre de la carte de ce résultat dans le flux de l'utilisateur : UNE phrase complète, qui se suffit à elle-même et dit ce qui a été fait ou trouvé (ou ce qui bloque), compréhensible sans lire le compte rendu. ` +
      `Jamais un fragment, jamais le début ou la fin d'une phrase du compte rendu. Première personne, comme l'agent qui parle à l'utilisateur et le tutoie (« J'ai corrigé… », « La page est en ligne… »), mots simples, 160 caractères au plus. ` +
      `Aucun chemin de fichier, commande, identifiant de commit ni jargon ; pas de guillemets autour, pas d'emoji ; rien d'inventé. En français. Réponds uniquement par la phrase.`,
  },
  en: {
    intentAmbiguous: 'Several existing tasks match. Open the relevant conversation to identify which one, without submitting the work again.',
    intentUncertain: 'Receipt of this request is still uncertain. Check the existing conversation before sending it again.',
    followWork: 'View existing work',
    invalidVisual: 'invalid visual proposal or unavailable destination',
    notFound: 'this is no longer in the stream',
    localOnly: 'only from this machine',
    emptyText: 'nothing to say',
    technicalPost: 'publish the useful outcome, not the engineering log',
    noReply: 'this cannot be replied to',
    noAction: 'this button is gone',
    cardGone: 'this proposal is gone',
    mailOff: 'mail is not set up',
    noMore: 'nothing more on this for now',
    noMedia: 'images and videos are not available here',
    waiting: 'I need you to keep going.',
    /** A finished session whose closing words give no whole sentence to show (only code, paths) and no title yet. */
    resultUntitled: 'Finished. Open it to read what was done.',
    cut: (why: string) => `Ouch, I got cut off mid-work (${why}). Want me to pick it back up?`,
    resume: 'Resume',
    paceOut: (tool: string, used: number, gone: number, hours: number) => `${tool} has used ${used}% of its week in ${gone}% of the time. At this pace it runs dry ~${hours} h before the reset.`,
    paceRoom: (tool: string, used: number, days: number) => `${tool} has only used ${used}% of its week with ${days} days to the reset. Room for a big job.`,
    usage: (tool: string, window: string, percent: number, spare: string) =>
      `You're at ${percent}% of your ${tool ? `${tool} ` : ''}${window}. ${spare ? `I'm keeping ${spare} warm just in case.` : 'I’m easing off what can wait.'}`,
    window_session: '5 h window',
    window_week: 'week',
    window_model: (label: string) => `${label} week`,
    saturated: (machine: string) => `${machine} is out of breath, I'm not piling more on it.`,
    diskFull: (machine: string, percent: number) => `${machine}'s disk is ${percent}% full, time for a little cleanup.`,
    offline: (machine: string) => `I can't reach ${machine} anymore.`,
    autoFailed: (title: string, note: string) => `The automation "${title}" crashed${note ? ` (${note})` : ''}. Retry or drop it?`,
    deployed: (hash: string) => `weevils version ${hash} is live. You can use it right here.`,
    commit: (repo: string, hash: string, subject: string) => `${repo} has a new commit (${hash}): ${subject}`,
    autoProposed: (title: string) => `I have an idea for you: "${title}". You can find it in the proposals.`,
    /** An auto task that carries out what the user said themselves: never passed off as weevils' idea. */
    autoOwn: (title: string) => `Your idea, ready to run: "${title}". It’s waiting in the proposals.`,
    ownWhy: 'Your idea, ready to run.',
    ownProposals: (n: number) => (n === 1 ? 'Your idea is ready to run' : `Your ${n} ideas are ready to run`),
    autoGo: (title: string) => `I started the automation "${title}" while the machine catches its breath.`,
    autoDone: (title: string, note: string) => `The automation "${title}" is wrapped up${note ? `: ${note}` : '.'}`,
    proposals: (n: number) => (n === 1 ? 'I have an idea for you' : `I have ${n} ideas for you`),
    go: (label: string) => `Go ahead: ${label}`,
    actBrief: (post: string, brief: string) => `the user tapped this button under your post in their "for you" stream ("${post}"). To do: ${brief}`,
    replyBrief: (post: string) => `answer the message above: the user wrote it in their "for you" stream, as a reply to your post "${post}"`,
    resultTitle: (project: string, asked: string, text: string) =>
      `Here is the end-of-turn report of a coding agent working on the project "${project}"${asked ? `; the user had asked it: ${asked}` : ''}.\n\nReport:\n${text}\n\n` +
      `Write the title of this result's card in the user's feed: ONE complete sentence that stands on its own and says what was done or found (or what is blocking), understandable without reading the report. ` +
      `Never a fragment, never the start or the end of a sentence from the report. First person, as the agent talking to the user ("I fixed…", "The page is live…"), plain words, 160 characters at most. ` +
      `No file path, command, commit id or jargon; no surrounding quotes, no emoji; nothing made up. In English. Answer with the sentence only.`,
  },
})
