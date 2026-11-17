import { defineMessages } from './index'
export default defineMessages({
 fr: {
  unavailable: 'La destination était indisponible lors de cet envoi. Le texte est conservé ; vérifie sa réception avant de le renvoyer.',
  closeError: 'masquer cette notification',
  payloadMissing: 'Contenu local indisponible : restaure le brouillon ou sélectionne à nouveau les pièces jointes.',
  storageFailed: 'Le stockage local est indisponible. Ton brouillon est conservé ; aucun envoi lancé.',
  sending: 'envoi…', accepted: 'reçu', delivering: 'reçu', waiting: 'reçu, en attente de son tour', notSentYet: 'pas encore parti', retry: 'réessayer', delivered: 'transmis à l’agent', uncertain: 'pas sûr que ce soit arrivé', failed: 'pas envoyé', unconfirmed: 'Confirmation indisponible. Ton brouillon est conservé ; réessayer vérifiera le même envoi.', recover: 'copier le texte', copied: 'texte copié', dismiss: 'masquer cet état', open: 'ouvrir la conversation',
 },
 en: {
  unavailable: 'The destination was unavailable for this submission. Your text is kept; check whether it arrived before sending again.',
  closeError: 'close this notice',
  payloadMissing: 'Local content unavailable: restore the draft or select the attachments again.',
  storageFailed: 'Local storage is unavailable. Your draft is saved; nothing was submitted.',
  sending: 'sending…', accepted: 'received', delivering: 'received', waiting: 'received, waiting for its turn', notSentYet: 'not sent yet', retry: 'try again', delivered: 'forwarded to the agent', uncertain: 'not sure it arrived', failed: 'not sent', unconfirmed: 'Confirmation unavailable. Your draft is saved; retrying will check the same submission.', recover: 'copy the text', copied: 'text copied', dismiss: 'dismiss this status', open: 'open conversation',
 },
})
