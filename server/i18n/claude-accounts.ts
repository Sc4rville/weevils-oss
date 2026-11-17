// Several Claude accounts of the user's own (server/claude-accounts.ts): the line a session gets when it carries on
// under the next account, and what weevboss says about it.
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    /** Posted in the session's thread (signed weevboss) when it is reopened under the next account: also its prompt. */
    switched: (n: number) => `Passée sur le compte Claude ${n}. Reprends exactement là où tu t’es arrêtée.`,
    /** Once, when the relay first comes up and only one account is known. */
    offer: 'Si tu as un autre compte Claude à toi, je peux l’ajouter : les sessions continueraient dessus d’elles-mêmes.',
    added: (n: number, who: string) => `Compte Claude ${n} ajouté${who ? ` (${who})` : ''}. S’il le faut, les sessions passeront dessus toutes seules.`,
    same: 'Ce compte Claude est déjà dans weevils : connecte-toi avec un autre compte à toi.',
    off: 'Plusieurs comptes Claude ne sont pas encore activés sur cette machine.',
    ask: 'Connecte-toi avec ton autre compte Claude sur la page officielle qui s’ouvre, puis colle ici le code qu’elle affiche.',
    failed: (why: string) => `Le compte n’a pas pu être ajouté : ${why}.`,
  },
  en: {
    switched: (n: number) => `Switched to Claude account ${n}. Carry on exactly where you stopped.`,
    offer: 'If you have another Claude account of your own, I can add it: sessions would carry on there by themselves.',
    added: (n: number, who: string) => `Claude account ${n} added${who ? ` (${who})` : ''}. When needed, sessions move to it by themselves.`,
    same: 'This Claude account is already in weevils: sign in with another account of yours.',
    off: 'Several Claude accounts are not turned on on this machine yet.',
    ask: 'Sign in with your other Claude account on the official page that opens, then paste the code it shows here.',
    failed: (why: string) => `The account could not be added: ${why}.`,
  },
})
