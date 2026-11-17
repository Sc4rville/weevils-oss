import { defineMessages } from '../i18n.ts'

/** Existing 13f6f22 product rule, shared by generated orchestrator instructions and project handoffs. */
export default defineMessages({
  fr: { rule: 'Écris directement le résultat, sans préfixe de machine [PC], [VPS] ou [GPU]. La machine reste dans les métadonnées de l’interface ; mentionne-la naturellement dans la prose seulement si elle explique le travail, par exemple le serveur du rendu et la machine du navigateur. Conserve les citations verbatim, le code, les transcriptions brutes et les identifiants. Transmets cette même convention aux agents lors des passations.' },
  en: { rule: 'Write the result directly, without machine prefixes [PC], [VPS] or [GPU]. The machine stays in interface metadata; mention it naturally in prose only when it explains the work, for example the render host and the browser host. Preserve verbatim quotations, code, raw transcripts and identifiers. Carry this same convention to agents during handoffs.' },
})
