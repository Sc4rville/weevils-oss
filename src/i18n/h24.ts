import { defineMessages } from './index'

// src/ui/h24.tsx: the bottom rail of always-on activities (jobs, schedules).
export default defineMessages({
  fr: {
    title: 'h24',
    region: 'activités h24',
    summary: (running: number, recent: number) => `${running} en cours · ${recent} récent${recent > 1 ? 's' : ''}`,
    nothing: 'rien ne tourne en continu',
    head: (summary: string, open: boolean) => `h24 : ${summary}. ${open ? 'replier' : 'déplier'}`,
    running: (since: string | null) => `en cours${since ? ` depuis ${since}` : ''}`,
    finished: (ago: string) => `terminé ${ago}`,
    paused: 'en pause',
    scheduled: 'planifié',
    resume: (title: string) => `reprendre ${title}`,
    pause: (title: string) => `mettre en pause ${title}`,
    empty: 'rien',
  },
  en: {
    title: '24/7',
    region: '24/7 activities',
    summary: (running: number, recent: number) => `${running} running · ${recent} recent`,
    nothing: 'nothing running around the clock',
    head: (summary: string, open: boolean) => `24/7: ${summary}. ${open ? 'collapse' : 'expand'}`,
    running: (since: string | null) => `running${since ? ` for ${since}` : ''}`,
    finished: (ago: string) => `finished ${ago}`,
    paused: 'paused',
    scheduled: 'scheduled',
    resume: (title: string) => `resume ${title}`,
    pause: (title: string) => `pause ${title}`,
    empty: 'nothing',
  },
})
