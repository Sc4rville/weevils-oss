import { defineMessages } from './index'

// First-tap hints (src/ui/hints.tsx): what the element is, then what to do with it. Short, generic.
export default defineMessages({
  fr: {
    voice: 'le logo, c’est la voix de weevboss. tape pour lui parler, encore pour arrêter, une dernière fois pour envoyer. garde le doigt dessus pour une conversation en direct',
    star: 'l’étoile tourne quand un agent travaille. elle s’arrête quand il a fini ou qu’il t’attend',
    newSession: 'le + lance une session claude ou codex dans ce projet. tape encore pour la décrire',
    attention: 'le ? mène à la session qui attend ta réponse',
    h24: 'la bande automatisations : ce qui tourne tout seul, même téléphone éteint, et les tâches proposées. tape encore pour l’ouvrir',
    repos: 'tous tes projets GitHub. le + en met un dans le fil, un nom l’ouvre',
    calm: 'le mode conversation : rien que les messages. tape-en une pour y entrer, pince encore pour revenir',
    devil: 'le diable : un autre modèle, sans filtre, dans ce même fil. tape encore pour basculer',
    voiceOff: 'la voix n’est pas encore branchée : weevboss te dit comment, en haut',
    reposOff: 'github n’est pas encore branché : weevboss te dit comment, en haut',
    newSessionOff: 'claude code n’est pas encore connecté : weevboss te dit comment, en haut',
  },
  en: {
    voice: 'the logo is weevboss’s voice. tap to talk, again to stop, once more to send. hold it for a live conversation',
    star: 'the star spins while an agent works. it stops when it is done or waiting for you',
    newSession: 'the + starts a claude or codex session in this project. tap again to describe it',
    attention: 'the ? takes you to the session waiting for your answer',
    h24: 'the automations band: what runs on its own, even with your phone off, and the tasks on offer. tap again to open it',
    repos: 'all your GitHub projects. the + puts one in the feed, a name opens it',
    calm: 'conversation mode: just the messages. tap one to step in, pinch again to come back',
    devil: 'the devil: another model, unfiltered, in this same thread. tap again to switch',
    voiceOff: 'the voice isn’t plugged in yet: weevboss tells you how, up top',
    reposOff: 'github isn’t plugged in yet: weevboss tells you how, up top',
    newSessionOff: 'claude code isn’t signed in yet: weevboss tells you how, up top',
  },
})
