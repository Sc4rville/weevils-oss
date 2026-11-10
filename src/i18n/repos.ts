import { defineMessages } from './index'

export default defineMessages({
  fr: {
    title: 'repos',
    count: (n: number) => `${n} repo${n > 1 ? 's' : ''}`,
    name: 'nom',
    nameLabel: 'nom du repo',
    desc: 'une phrase',
    descLabel: 'description du repo',
    create: 'créer le repo',
    unpin: (repo: string) => `retirer ${repo} du fil`,
    pin: (repo: string) => `épingler ${repo} au fil`,
  },
  en: {
    title: 'repos',
    count: (n: number) => `${n} repo${n === 1 ? '' : 's'}`,
    name: 'name',
    nameLabel: 'repo name',
    desc: 'one sentence',
    descLabel: 'repo description',
    create: 'create repo',
    unpin: (repo: string) => `unpin ${repo} from the feed`,
    pin: (repo: string) => `pin ${repo} to the feed`,
  },
})
