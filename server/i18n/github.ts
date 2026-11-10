// Messages of server/github.ts: API errors and the prompt that writes one human sentence per repo,
// in the user's language.
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    ghMissing: 'gh (GitHub CLI) n’est pas installé sur cette machine : installe-le, puis gh auth login',
    badRepo: 'repo invalide',
    badPath: 'chemin refusé',
    badRepoName: 'nom de repo invalide',
    exists: (name: string, root: string) => `${name} existe déjà dans ${root}`,
    noClone: 'clone absent après création',
    blurbPrompt: (user: string, repos: string) =>
      [
        `Pour chaque repo GitHub de ${user}, écris en français UNE phrase courte (3 à 8 mots, minuscule initiale, sans point final) qui dit ce que c’est, comme on le dirait à un ami : « le jeu mobile », « le site des cours de surf », « l’app qui pilote ses agents ».`,
        'Jamais de jargon ni de liste de technologies, jamais le nom du repo recopié, jamais la description brute. Si le README ne dit rien de clair, devine d’après le nom et reste sobre (ex. « un essai mis de côté »).',
        'Ne lis aucun fichier, ne lance aucune commande : réponds directement.',
        '',
        repos,
      ].join('\n'),
    /** One repo of the prompt, as JSON (keys in the prompt's language). */
    blurbItem: (name: string, description: string, readme: string, language: string) => JSON.stringify({ name, description, readme, langage: language }),
  },
  en: {
    ghMissing: 'gh (GitHub CLI) is not installed on this machine: install it, then gh auth login',
    badRepo: 'invalid repo',
    badPath: 'path not allowed',
    badRepoName: 'invalid repo name',
    exists: (name: string, root: string) => `${name} already exists in ${root}`,
    noClone: 'repo created but the clone is missing',
    blurbPrompt: (user: string, repos: string) =>
      [
        `For each of ${user}'s GitHub repos, write in English ONE short phrase (3 to 8 words, lowercase first letter, no final period) that says what it is, the way you'd tell a friend: "the mobile game", "the surf lessons website", "the app that runs their agents".`,
        'No jargon and no list of technologies, never the repo name copied over, never the raw description. If the README says nothing clear, guess from the name and keep it plain (e.g. "a shelved experiment").',
        "Don't read any file, don't run any command: answer directly.",
        '',
        repos,
      ].join('\n'),
    blurbItem: (name: string, description: string, readme: string, language: string) => JSON.stringify({ name, description, readme, language }),
  },
})
