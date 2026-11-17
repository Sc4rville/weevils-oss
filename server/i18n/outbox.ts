import { defineMessages } from '../i18n.ts'
export default defineMessages({
  fr: { providerWaiting: 'Le message est conservé et attend qu’un agent soit disponible. Aucun renvoi nécessaire.', invalid: 'Identifiant de message invalide.', conflict: 'Cet identifiant correspond déjà à un autre message.', uncertain: 'Le message est enregistré, mais sa réception par l’agent reste à confirmer. Ne le renvoie pas.', failed: 'Le message n’a pas pu être livré.', missing: 'Ce message n’est pas encore enregistré.' },
  en: { providerWaiting: 'Your message is saved and waiting for an available agent. No need to resend it.', invalid: 'Invalid message identifier.', conflict: 'This identifier already belongs to another message.', uncertain: 'The message is saved, but receipt by the agent is still unconfirmed. Do not resend it.', failed: 'The message could not be delivered.', missing: 'This message has not been saved yet.' },
})
