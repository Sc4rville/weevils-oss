// The « for you » stream (server/foryou.ts): the one-line texts of what weevilsd computes itself (alerts, a cut
// session, the proposals band), the reasons of a refused request, and the hidden notes that go to weevboss with a
// tap or a reply. The curator's prompts (generated items) will live here too.
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
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
    /** A session cut off mid-work; `why` comes from the core catalog (cutWhy). */
    cut: (why: string) => `Aïe, on m’a coupé en plein travail (${why}). Tu me relances ?`,
    resume: 'Reprendre',
    // ---- alerts (one sober line each)
    usage: (tool: string, window: string, percent: number, spare: string) =>
      `T’es à ${percent} % de ta ${window} ${tool}. ${spare ? `Je garde ${spare} au chaud au cas où.` : 'Je lève le pied sur ce qui peut attendre.'}`,
    window_session: 'fenêtre de 5 h',
    window_week: 'semaine',
    window_model: (label: string) => `semaine ${label}`,
    saturated: (machine: string) => `${machine} est à bout de souffle, j’évite de lui en rajouter.`,
    diskFull: (machine: string, percent: number) => `Le disque de ${machine} est plein à ${percent} %, faudrait faire un peu de ménage.`,
    offline: (machine: string) => `Je n’arrive plus à joindre ${machine}.`,
    autoFailed: (title: string, note: string) => `La tâche auto « ${title} » s’est plantée${note ? ` (${note})` : ''}. On retente ou on laisse tomber ?`,
    // ---- proposals
    deployed: (hash: string) => `La version ${hash} de weevils est en ligne. Tu peux la retrouver ici.`,
    commit: (repo: string, hash: string, subject: string) => `${repo} a un nouveau commit (${hash}) : ${subject}`,
    autoProposed: (title: string) => `J’ai une idée pour toi : « ${title} ». Tu peux la retrouver dans les propositions.`,
    autoGo: (title: string) => `J’ai lancé la tâche auto « ${title} » pendant que la machine souffle un peu.`,
    autoDone: (title: string, note: string) => `La tâche auto « ${title} » est bouclée${note ? ` : ${note}` : '.'}`,
    proposals: (n: number) => (n > 1 ? `J’ai ${n} idées pour toi` : 'J’ai une idée pour toi'),
    // ---- what weevboss receives
    /** The visible message of a tapped button under a post. */
    go: (label: string) => `Vas-y : ${label}`,
    /** Hidden note joined to that message (never shown in the thread). */
    actBrief: (post: string, brief: string) => `l'utilisateur a touché ce bouton sous ton mot dans son flux « pour toi » (« ${post} »). À faire : ${brief}`,
    /** Hidden note joined to a reply typed under a post. */
    replyBrief: (post: string) => `réponds au message ci-dessus : l'utilisateur l'a écrit dans son flux « pour toi », en réponse à ton mot « ${post} »`,
  },
  en: {
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
    cut: (why: string) => `Ouch, I got cut off mid-work (${why}). Want me to pick it back up?`,
    resume: 'Resume',
    usage: (tool: string, window: string, percent: number, spare: string) =>
      `You're at ${percent}% of your ${tool ? `${tool} ` : ''}${window}. ${spare ? `I'm keeping ${spare} warm just in case.` : 'I’m easing off what can wait.'}`,
    window_session: '5 h window',
    window_week: 'week',
    window_model: (label: string) => `${label} week`,
    saturated: (machine: string) => `${machine} is out of breath, I'm not piling more on it.`,
    diskFull: (machine: string, percent: number) => `${machine}'s disk is ${percent}% full, time for a little cleanup.`,
    offline: (machine: string) => `I can't reach ${machine} anymore.`,
    autoFailed: (title: string, note: string) => `The auto task "${title}" crashed${note ? ` (${note})` : ''}. Retry or drop it?`,
    deployed: (hash: string) => `weevils version ${hash} is live. You can use it right here.`,
    commit: (repo: string, hash: string, subject: string) => `${repo} has a new commit (${hash}): ${subject}`,
    autoProposed: (title: string) => `I have an idea for you: "${title}". You can find it in the proposals.`,
    autoGo: (title: string) => `I started the auto task "${title}" while the machine catches its breath.`,
    autoDone: (title: string, note: string) => `The auto task "${title}" is wrapped up${note ? `: ${note}` : '.'}`,
    proposals: (n: number) => (n === 1 ? 'I have an idea for you' : `I have ${n} ideas for you`),
    go: (label: string) => `Go ahead: ${label}`,
    actBrief: (post: string, brief: string) => `the user tapped this button under your post in their "for you" stream ("${post}"). To do: ${brief}`,
    replyBrief: (post: string) => `answer the message above: the user wrote it in their "for you" stream, as a reply to your post "${post}"`,
  },
})
