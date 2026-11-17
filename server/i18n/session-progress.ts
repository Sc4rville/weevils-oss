import { defineMessages } from '../i18n.ts'
export default defineMessages({
 fr: { render: 'Rendu des déplacements', review: 'Rendu prêt à vérifier', waiting: 'Suivi du rendu', error: 'Rendu interrompu', verified: (n: number) => `${n} images vérifiées et récupérées` },
 en: { render: 'Rendering transitions', review: 'Render ready to review', waiting: 'Render monitoring', error: 'Rendering interrupted', verified: (n: number) => `${n} images verified and downloaded` },
})
