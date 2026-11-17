import { defineMessages } from '../i18n.ts'
export default defineMessages({
  fr: {
    none: 'rien la semaine dernière',
    change: (n: number) => `contre ${n} la semaine dernière`,
    left: (n: number) => `, ${n} encore en cours`,
    requests: (n: number, title: string, change: string, left: string) => `${n} demandes bouclées cette semaine pour « ${title} », ${change}${left}.`,
    commits: (n: number, name: string, change: string) => `${n} commits livrés sur ${name} cette semaine, ${change}.`,
  },
  en: {
    none: 'none last week',
    change: (n: number) => `vs ${n} last week`,
    left: (n: number) => `, ${n} still open`,
    requests: (n: number, title: string, change: string, left: string) => `${n} requests closed this week toward “${title}”, ${change}${left}.`,
    commits: (n: number, name: string, change: string) => `${n} commits shipped on ${name} this week, ${change}.`,
  },
})
