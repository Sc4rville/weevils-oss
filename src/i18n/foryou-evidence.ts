import { defineMessages } from './index'
export default defineMessages({
  en: {
    implemented: 'Built',
    demonstrated: 'Shown working',
    verified: 'Verified',
    aboutImplemented: 'The code is there. Nobody has seen it run yet.',
    aboutDemonstrated: (where: string) => `Seen running: ${where}. Not verified yet.`,
    aboutVerified: (environment: string) => `Checked on ${environment}.`,
    supplied: 'From the evidence sent with this result, never from how it is described.',
    limits: 'Not checked yet',
  },
  fr: {
    implemented: 'Codé',
    demonstrated: 'Vu en marche',
    verified: 'Vérifié',
    aboutImplemented: 'Le code est là. Personne ne l’a encore vu tourner.',
    aboutDemonstrated: (where: string) => `Vu en marche : ${where}. Pas encore vérifié.`,
    aboutVerified: (environment: string) => `Vérifié sur ${environment}.`,
    supplied: 'D’après les preuves jointes à ce résultat, jamais d’après sa description.',
    limits: 'Pas encore vérifié',
  },
})
