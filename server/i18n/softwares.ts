// Messages of server/softwares.ts: API errors of the « my software » page, the short reasons of the progress
// estimate (computed without a model) and the prompt that asks a model for it, in the user's language.
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    notFound: 'logiciel introuvable',
    nothingToLaunch: 'rien à lancer ici',
    notOurs: 'weevils n’a rien lancé ici',
    badFix: 'correction invalide',
    noPort: 'aucun port libre',
    noShot: 'pas de capture',
    portBusy: (port: number) => `le port ${port} est déjà pris par autre chose`,
    allInterfaces: (port: number) => `! il écoute sur toutes les adresses (port ${port}) : arrêté, il doit écouter sur 127.0.0.1 seulement`,
    tooLong: '! toujours rien sur le port : arrêté',
    // Raisons courtes (au plus ~60 caractères une fois jointes par « · »).
    visitors: (n: number) => `${n} visiteur${n > 1 ? 's' : ''} en 7 jours`,
    stars: (n: number) => `${n} étoile${n > 1 ? 's' : ''} GitHub`,
    forks: (n: number) => `${n} fork${n > 1 ? 's' : ''}`,
    issues: (n: number) => `${n} ticket${n > 1 ? 's' : ''} venus d’ailleurs`,
    online: 'en ligne',
    running: 'tourne',
    version: (v: string) => `version ${v}`,
    tests: (n: number) => `${n} fichier${n > 1 ? 's' : ''} de test`,
    noTests: 'sans tests',
    commits: (n: number) => `${n} commit${n > 1 ? 's' : ''}`,
    todo: (done: number, total: number) => `${done}/${total} tâches`,
    works: 'marche d’après les sessions',
    estimatePrompt: (user: string, items: string, examples: string) =>
      [
        `Tu estimes l’avancement des logiciels de ${user} à partir de signaux réels (repo, commits, tests, README, déploiement, visiteurs, échanges avec ses agents).`,
        'Trois phases :',
        '1 = pas encore de première version utilisable ; percent = chemin parcouru jusqu’à elle.',
        '2 = une version utilisable existe (déployée, ou qui marche d’après les échanges) et le travail continue ; percent = maturité de cette version.',
        '3 = de vrais utilisateurs ou clients autres que lui (visiteurs distincts, étoiles, tickets d’autres personnes, clients cités) ; percent = traction, échelle logarithmique (5 personnes ≈ 20, 100 ≈ 65, 1000+ ≈ 100).',
        'Sois sobre : un repo tout jeune sans tests reste bas ; « visitors » exclut déjà ses propres adresses.',
        'reason : au plus 60 caractères, en français, concret (« en ligne, 40 visiteurs cette semaine »), sans répéter le nom.',
        examples ? `Corrections faites par ${user} (calibre-toi dessus) : ${examples}` : '',
        'Réponds UNIQUEMENT par du JSON : {"items":[{"id":"…","phase":1,"percent":40,"reason":"…"}]}, un élément par logiciel.',
        'Ne lis aucun fichier, ne lance aucune commande.',
        '',
        items,
      ]
        .filter((l, i) => l || i > 8)
        .join('\n'),
  },
  en: {
    notFound: 'software not found',
    nothingToLaunch: 'nothing to launch here',
    notOurs: 'weevils did not launch anything here',
    badFix: 'invalid correction',
    noPort: 'no free port',
    noShot: 'no screenshot',
    portBusy: (port: number) => `port ${port} is already taken by something else`,
    allInterfaces: (port: number) => `! it listens on every address (port ${port}): stopped, it must listen on 127.0.0.1 only`,
    tooLong: '! still nothing on the port: stopped',
    visitors: (n: number) => `${n} visitor${n === 1 ? '' : 's'} in 7 days`,
    stars: (n: number) => `${n} GitHub star${n === 1 ? '' : 's'}`,
    forks: (n: number) => `${n} fork${n === 1 ? '' : 's'}`,
    issues: (n: number) => `${n} issue${n === 1 ? '' : 's'} from others`,
    online: 'online',
    running: 'running',
    version: (v: string) => `version ${v}`,
    tests: (n: number) => `${n} test file${n === 1 ? '' : 's'}`,
    noTests: 'no tests',
    commits: (n: number) => `${n} commit${n === 1 ? '' : 's'}`,
    todo: (done: number, total: number) => `${done}/${total} tasks`,
    works: 'works, per the sessions',
    estimatePrompt: (user: string, items: string, examples: string) =>
      [
        `You estimate how far along ${user}'s software projects are, from real signals (repo, commits, tests, README, deployment, visitors, exchanges with their agents).`,
        'Three phases:',
        '1 = no first usable version yet; percent = how far along the way to it.',
        '2 = a usable version exists (deployed, or working according to the exchanges) and work continues; percent = maturity of that version.',
        '3 = real users or customers other than them (distinct visitors, stars, issues by other people, customers mentioned); percent = traction, log scale (5 people ≈ 20, 100 ≈ 65, 1000+ ≈ 100).',
        'Be sober: a very young repo without tests stays low; "visitors" already excludes their own addresses.',
        'reason: at most 60 characters, in English, concrete ("online, 40 visitors this week"), without repeating the name.',
        examples ? `Corrections made by ${user} (calibrate on them): ${examples}` : '',
        'Answer ONLY with JSON: {"items":[{"id":"…","phase":1,"percent":40,"reason":"…"}]}, one item per software.',
        'Do not read any file, do not run any command.',
        '',
        items,
      ]
        .filter((l, i) => l || i > 8)
        .join('\n'),
  },
})
