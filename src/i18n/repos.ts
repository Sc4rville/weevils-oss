import { defineMessages } from './index'

export default defineMessages({
  fr: {
    title: 'GitHub',
    count: (n: number) => `${n} projet${n > 1 ? 's' : ''}`,
    name: 'nom',
    nameLabel: 'nom du projet',
    desc: 'une phrase',
    descLabel: 'description du projet',
    create: 'créer sur GitHub',
    unpin: (repo: string) => `retirer ${repo} du fil`,
    pin: (repo: string) => `épingler ${repo} au fil`,
    plugGithub: 'connecter GitHub',
  },
  en: {
    title: 'GitHub',
    count: (n: number) => `${n} project${n === 1 ? '' : 's'}`,
    name: 'name',
    nameLabel: 'project name',
    desc: 'one sentence',
    descLabel: 'project description',
    create: 'create on GitHub',
    unpin: (repo: string) => `unpin ${repo} from the feed`,
    pin: (repo: string) => `pin ${repo} to the feed`,
    plugGithub: 'connect GitHub',
  },
})
