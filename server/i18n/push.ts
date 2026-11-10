// Push notifications (server/push.ts, sent from server/core.ts and server/index.ts).
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    badSubscription: 'abonnement invalide',
    /** A session started waiting for the user. */
    waitingTitle: (project: string) => `${project} t’attend`,
    waitingBody: 'attend ta réponse',
    /** A session finished a piece of work. */
    doneTitle: (project: string) => `${project} a fini`,
    testBody: 'Les notifications marchent. Je te préviens quand une session t’attend ou a fini.',
  },
  en: {
    badSubscription: 'invalid subscription',
    waitingTitle: (project: string) => `${project} needs you`,
    waitingBody: 'waiting for your answer',
    doneTitle: (project: string) => `${project} is done`,
    testBody: 'Notifications work. I’ll ping you when a session needs you or is done.',
  },
})
