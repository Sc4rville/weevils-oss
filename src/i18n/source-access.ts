import { defineMessages } from './index'
export default defineMessages({
 en: {
  'not-owned': 'Read-only source: it belongs to another system account. New work is disabled.',
  'not-writable': 'Read-only source: this account cannot write to it. New work is disabled.',
  'no-checkout': 'The app is installed without editable source. New source work is unavailable.',
  unavailable: 'Source unavailable. New work is disabled.',
  unknown: 'Source access has not been verified. New work is disabled.',
 },
 fr: {
  'not-owned': 'Sources en lecture seule : elles appartiennent à un autre compte système. Aucun nouveau travail ne peut démarrer.',
  'not-writable': 'Sources en lecture seule : ce compte ne peut pas les modifier. Aucun nouveau travail ne peut démarrer.',
  'no-checkout': 'L’application est installée sans sources modifiables. Aucun nouveau travail sur les sources ne peut démarrer.',
  unavailable: 'Sources indisponibles. Aucun nouveau travail ne peut démarrer.',
  unknown: 'Les droits sur les sources ne sont pas encore vérifiés. Aucun nouveau travail ne peut démarrer.',
 },
})
