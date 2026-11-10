import { defineMessages } from './index'

// First-tap hints (src/ui/hints.tsx): what the element is, then what to do with it. Short, generic.
export default defineMessages({
  fr: {
    voice: 'le logo, c’est la voix de weevboss. tape pour lui parler, encore pour arrêter, une dernière fois pour envoyer',
    star: 'l’étoile tourne quand un agent travaille. elle s’arrête quand il a fini ou qu’il t’attend',
    newSession: 'le + lance une session claude ou codex dans ce projet. tape encore pour la décrire',
    attention: 'le ! mène à la session qui attend ta réponse',
    h24: 'la bande h24 : ce qui tourne en continu, même téléphone éteint. tape encore pour l’ouvrir',
    repos: 'tous tes repos github. le + en met un dans le fil, un nom l’ouvre',
    calm: 'le mode conversation : rien que les messages. tape-en une pour y entrer, pince encore pour revenir',
  },
  en: {
    voice: 'the logo is weevboss’s voice. tap to talk, again to stop, once more to send',
    star: 'the star spins while an agent works. it stops when it is done or waiting for you',
    newSession: 'the + starts a claude or codex session in this project. tap again to describe it',
    attention: 'the ! takes you to the session waiting for your answer',
    h24: 'the 24/7 band: what runs around the clock, even with your phone off. tap again to open it',
    repos: 'all your github repos. the + puts one in the feed, a name opens it',
    calm: 'conversation mode: just the messages. tap one to step in, pinch again to come back',
  },
})
