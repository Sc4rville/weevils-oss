import { defineMessages } from './index'

export default defineMessages({
  fr: {
    frame: 'page',
    openTab: 'ouvrir dans un onglet',
    kind: (k: string) => ({ opportunities: 'pistes', library: 'médiathèque', preview: 'aperçu', report: 'rapport', render: 'rendu' })[k] ?? k,
  },
  en: {
    frame: 'page',
    openTab: 'open in a tab',
    kind: (k: string) => ({ opportunities: 'opportunities', library: 'library', preview: 'preview', report: 'report', render: 'render' })[k] ?? k,
  },
})
