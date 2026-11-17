import { defineMessages } from './index'

// A project's page (src/ui/project-screen.tsx): what runs now, its to-do, its sessions. No headings: only these.
export default defineMessages({
  fr: {
    openAria: (name: string) => `ouvrir ${name}`,
    now: 'en ce moment',
    todo: 'à faire',
    more: (n: number) => `${n} de plus`,
    older: (n: number) => `${n} session${n > 1 ? 's' : ''} plus ancienne${n > 1 ? 's' : ''}`,
  },
  en: {
    openAria: (name: string) => `open ${name}`,
    now: 'right now',
    todo: 'to do',
    more: (n: number) => `${n} more`,
    older: (n: number) => `${n} older session${n === 1 ? '' : 's'}`,
  },
})
