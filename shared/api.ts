import type { Ask } from './asks.ts'
import type { Tour } from './tour.ts'
import type { ForYouMark } from './foryou.ts'

// Contrat entre weevilsd (VPS) et l'app. Horodatages en millisecondes, compteurs toujours dérivés côté app.

export type Tool = 'claude' | 'codex'
/** interrupted : coupée en plein travail (processus mort, pane fermée, erreur d'API ou quota), jamais confondue avec done. */
export type SessionStatus = 'working' | 'needs_user' | 'idle' | 'done' | 'interrupted'

/**
 * Pourquoi une session est « interrupted » : died (processus ou pane disparus en plein tour, ou avec du travail
 * d'arrière-plan en cours), dirty (arrêtée sans fin propre avec du travail non commité), quota (limite d'usage),
 * auth (connexion expirée), api (autre erreur d'API ou de compaction qui a arrêté le tour).
 */
export type InterruptReason = 'died' | 'dirty' | 'quota' | 'auth' | 'api'

export interface Message {
  id: string
  /** orchestrator : message signé par un autre auteur que l'utilisateur (weevboss, ou un agent externe : voir author). */
  role: 'user' | 'assistant' | 'orchestrator' | 'event'
  /** role orchestrator : id de l'auteur (Snapshot.config.authors) ; absent = weevboss. */
  author?: string
  text: string
  at: number
  /** Échange du devil mode (autre modèle, même fil que weevboss). */
  devil?: boolean
  /** Fil de weevboss : les puces de branchement de ce message ([[setup:x]], retirées du texte), montrées en boutons. */
  chips?: string[]
  /** Premiers pas : message de démo (l'usage qu'il montre), marqué comme tel, retiré dès que la vraie brique est branchée. */
  demo?: string
}

/** Qui peut signer un message dans une session, à part l'utilisateur : weevboss et les agents externes (config du serveur). */
export interface Author {
  id: string
  name: string
  /** Couleur CSS de ses messages ; vide = le violet de weevboss. */
  color: string
}

/**
 * Travail lancé par une session et qui tourne à côté d'elle : sous-agent (outil Agent/Task), étape d'un workflow
 * (outil Workflow, un sous-agent par étape) ou commande lancée en arrière-plan (Bash run_in_background).
 */
export interface Subagent {
  id: string
  /** agent : sous-agent Agent/Task ; step : étape d'un workflow ; shell : commande en arrière-plan. */
  kind: 'agent' | 'step' | 'shell'
  /** Son nom : description de l'agent, label de l'étape (« build:page »), description de la commande. */
  label: string
  /** Ce qu'il fait en ce moment (dernier outil utilisé, dernière phrase) ; sa tâche quand il a fini. */
  activity: string
  /** Étapes de workflow : nom du workflow et phase de l'étape. */
  workflow?: string
  phase?: string
  /** working : tourne encore ; done : fini ; failed : fini en erreur ; stopped : coupé avant la fin (processus mort, arrêté). */
  status: 'working' | 'done' | 'failed' | 'stopped'
  startedAt: number
  endedAt?: number
}

/** Détail d'un sous-agent, à la demande (GET /api/sessions/:id/subagents/:subId) : ses derniers pas, du plus ancien au plus récent. */
export interface SubagentDetail {
  subagent: Subagent
  steps: { at: number; role: 'assistant' | 'tool' | 'result'; text: string }[]
}

/** Réglages d'une session tels que l'outil les écrit dans son transcript (inconnus quand absents). */
export interface SessionSettings {
  /** claude : opus / sonnet / haiku (ou l'id complet) ; codex : gpt-… */
  model?: string
  /** codex : on-request, never, untrusted… */
  approval?: string
  /** claude : low / medium / high / max, lu dans les requêtes du transcript. */
  effort?: string
}

export interface Session {
  /** Hidden from the ordinary list; the agent keeps running and can be restored. */
  archived?: boolean
  id: string
  projectId: string
  repo: string | null
  machineId: string
  tool: Tool
  title: string
  /** Ce que la session fait en ce moment (dernier bloc), une phrase courte. Écrit par le renommeur. */
  now?: string
  status: SessionStatus
  /** Ce qui t'attend (permission, question), quand status = needs_user. */
  attention?: string
  /** Stable notification event, independent of screen refreshes and background activity. */
  noticeId?: string
  /** Live selector options; ids are validated against the current screen before choosing. */
  choices?: { id: string; label: string }[]
  /** status = needs_user sans dialogue : le tour fini sur une question ou une demande (shared/asks.ts), pour l'action rapide. */
  ask?: Ask
  /** status = interrupted : quand et pourquoi (detail : le message d'erreur de l'outil, s'il y en a un). */
  interrupted?: { at: number; reason: InterruptReason; detail?: string }
  cwd: string
  branch?: string
  openedAt: number
  lastActivityAt: number
  /** Début du travail en cours ; null quand la session ne travaille pas. */
  workStartedAt: number | null
  /** weevils (lancée depuis l'app), terminal, headless… */
  origin: string
  /** weevils peut lui écrire (pane zellij pilotée, ou reprise headless possible). */
  controllable: boolean
  /** Un processus tourne encore. */
  live: boolean
  /** weevils voit son écran (pane zellij pilotée). */
  hasScreen: boolean
  subagents: Subagent[]
  /** Nombre de sous-agents, étapes de workflow et commandes d'arrière-plan qui tournent encore (0 : rien). Tant qu'il est > 0 et
   *  que le processus vit, la session est « working » : jamais « idle »/« done », jamais fermée par le ménage des panes. */
  background: number
  /** Le tour principal travaille, arrière-plan exclu (le pont e-mail attend la réponse, pas la fin des sous-agents).
   *  Absent d'un weevilsd plus ancien : status fait foi. */
  turnWorking?: boolean
  lastMessage?: string
  messageCount: number
  settings?: SessionSettings
  /** Messages reçus pendant que la session travaille, pas encore traités. */
  queued: number
  /** Session Codex ouverte en relais d'une session Claude arrêtée par la limite d'usage : l'id de cette session (server/relay.ts). */
  relayOf?: string
  /** Session Claude dont une session Codex a pris le relais : l'id de cette session Codex. */
  relayedBy?: string
}

/** Relais Codex quand Claude atteint sa limite : auto (Codex écrit son plan puis l'exécute), ask (le plan attend un oui), never. */
export type RelayMode = 'auto' | 'ask' | 'never'

/**
 * Plan de reprise d'une session arrêtée par la limite d'usage de Claude, écrit par Codex en lecture seule.
 * preparing : Codex lit le contexte ; ready : le plan attend une décision ; failed : Codex n'a pas pu l'écrire ;
 * running : validé, une session Codex (relayTo) fait le travail ; waiting : on attend le retour de Claude.
 */
export interface RelayPlan {
  /** This request has been answered; a rewritten or failed plan opens a new request. */
  resolved?: boolean
  sessionId: string
  title: string
  projectId: string
  state: 'preparing' | 'ready' | 'failed' | 'running' | 'waiting'
  /** Le plan (fait, reste, risques, ce que Codex compte faire). */
  text?: string
  /** Une version plus à jour est en cours d'écriture (plan préparé avant la coupure, ou ajustement demandé). */
  refreshing?: boolean
  error?: string
  at: number
  /** Tâche de la bande auto. */
  auto?: boolean
  relayTo?: string
}

/** Ce que l'app montre du relais (server/relay.ts). */
export interface RelayView {
  mode: RelayMode
  /** Codex est installé et connecté sur cette machine. */
  codex: boolean
  /** Seuil de bascule préventive, en % de la fenêtre (5 h ou semaine). */
  switchAt: number
  /** Claude est indisponible ou tout près de sa limite : near (seuil atteint), limit (limite atteinte), down (erreurs d'API répétées). */
  limit?: { kind: 'near' | 'limit' | 'down'; since: number; until: number | null; percent?: number; window?: 'session' | 'week' }
  /** weevboss répond par Codex en ce moment. */
  boss?: boolean
  plans: RelayPlan[]
}

export interface Project {
  id: string
  name: string
  /** 'repo' : famille de repos de ~/projects ; 'invented' : catégorie créée par weevils. */
  kind: 'repo' | 'invented'
  repos: string[]
  /** Machine qui porte chaque repo (fichiers, nouvelle session). */
  where: Record<string, string>
  lastActivityAt: number
}

/** Un repo GitHub du compte. */
export interface GithubRepo {
  name: string
  description: string
  isPrivate: boolean
  pushedAt: number
  language?: string
  /** Ce que c'est, en une phrase humaine (écrite une fois par weevils, en cache). */
  blurb?: string
}

export interface Machine {
  id: string
  name: string
  online?: boolean
}

export interface H24Activity {
  id: string
  title: string
  kind: 'timer' | 'job'
  projectId: string | null
  schedule: string
  enabled: boolean
  runState: 'running' | 'waiting' | 'paused'
  runStartedAt: number | null
  lastEvent: string
  canToggle: boolean
  /** Job de démo des premiers pas (server/tour.ts) : marqué comme tel, jamais confondu avec un vrai. */
  demo?: boolean
  /** Bande auto, d'un coup d'œil : prochaine exécution, période (lue dans le planning), dernière exécution, depuis quand
   *  la tâche existe, et la famille de son nom (projet probable, pour la ranger). */
  nextRunAt?: number | null
  everyMs?: number | null
  lastRunAt?: number | null
  since?: number | null
  group?: string
  /** Timer : la Description= de son unité (à quoi il sert). */
  description?: string
  /** Dernier passage : durée et issue ; nombre de passages connus (journal). */
  lastDurMs?: number | null
  lastOk?: boolean | null
  runCount?: number | null
}

/** Conversation ChatGPT / Claude.ai importée (sans ses messages). */
export interface ConversationSummary {
  id: string
  source: 'chatgpt' | 'claude'
  title: string
  projectId: string | null
  updatedAt: number
  messageCount: number
  preview: string
  /** new : pas encore vue ; auto : rangée par weevils ; pending : à ranger par toi ; accepted / corrected : ton choix ; none : laissée de côté. */
  status: 'new' | 'auto' | 'pending' | 'accepted' | 'corrected' | 'none'
  suggestedProjectId?: string
  reason?: string
  confidence?: number
}

export interface ConversationDetail {
  conversation: ConversationSummary
  messages: Message[]
}


// ---------------------------------------------------------------- mémoire, weevils volants, h24 qui ne dort jamais

/** Ce que weevils retient de l'utilisateur : ~/.config/weevils/memory.json (hors de tout repo, envoyé seulement au modèle). */
export interface MemoryItem {
  id: string
  /** Le souvenir, en une phrase courte (« veut lancer un jeu mobile cette année »). */
  text: string
  /** answer : tiré d'une réponse à un weevil volant (le reste même corrigé à la main) ; manual : ajouté à la main. */
  source: 'answer' | 'manual'
  /** source answer : la question portée par le weevil et la réponse d'où vient ce souvenir. */
  q?: string
  a?: string
  at: number
  updatedAt: number
}

/** La petite question portée par un weevil volant. */
export interface WeevilQuestion {
  id: string
  text: string
}

/** Réponse du weevil à ce qu'on lui a dit : une phrase de relance (ou de clôture) et ce qui a été retenu. */
export interface WeevilReply {
  reply: string
  /** Souvenirs ajoutés ou mis à jour par cette réponse. */
  learned: MemoryItem[]
  /** true : l'échange est fini (le weevil repart) ; false : sa phrase invite à répondre encore. */
  done: boolean
}

/** Une tâche du h24 (« optimiseur ») : proposée à partir de la mémoire et des projets, lancée quand la machine est libre. */
export interface Optimizer {
  id: string
  /** Ce que la tâche fait, très court (« muscler les tests de mon-app »). */
  title: string
  /** Pourquoi elle est proposée, une phrase (le lien avec un souvenir ou un projet). */
  why: string
  /** Repo où elle tourne (null : dans son propre dossier de travail, hors repo). */
  repo: string | null
  kind: 'tests' | 'watch' | 'content' | 'explore' | 'other'
  /** Builds, tests, installs : lancés via heavy quand il existe. */
  heavy: boolean
  /** proposed : attend un oui ou un non ; queued : acceptée, attend une machine libre ; running ; done ; failed ; refused. */
  state: 'proposed' | 'queued' | 'running' | 'done' | 'failed' | 'refused'
  /** Conversation de création encore à préciser : aucune exécution ni validation tant que true. */
  draft?: boolean
  /** Créée à l'initiative de l'utilisateur (+), distincte des suggestions automatiques plafonnées. */
  userCreated?: boolean
  /** Session de l'agent qui la fait tourner (visible dans son projet). */
  sessionId?: string
  createdAt: number
  startedAt?: number
  endedAt?: number
  /** Dernière nouvelle (fin de la réponse de l'agent, raison d'attente…). */
  lastEvent?: string
  /** 1 forte … 3 faible. */
  priority?: 1 | 2 | 3
  /** Durée estimée, en minutes. */
  est?: number
  /** queued : ce qu'elle attend (busy : un agent travaille ; load : machine chargée ; ram : mémoire ; queue : une autre tâche d'abord ;
   *  later : arrêtée par une limite d'usage ou une erreur, nouvel essai à retryAt ; time : son heure, à startAt). */
  waiting?: 'busy' | 'load' | 'ram' | 'queue' | 'later' | 'time' | 'paused'
  /** waiting later : quand elle sera relancée. */
  retryAt?: number
  /** Conditions négociées : pas avant (instant), chaque jour dans une fenêtre (minutes après minuit, heure de tz), toutes les every ms. */
  notBefore?: number
  window?: { from: number; to: number }
  every?: number
  /** Fuseau de l'utilisateur (envoyé par le téléphone) où se lisent notBefore et window. */
  tz?: string
  /** queued, retenue par ses conditions d'heure : quand elle pourra partir. */
  startAt?: number
  /** La négociation (POST /api/optimizers/:id/talk), les dernières lignes, gardée après validation : d'où vient la tâche. */
  talk?: OptimizerLine[]
  /** Ce que la dernière réécriture a changé (l'app fait clignoter ces champs). */
  changed?: { at: number; fields: OptimizerField[] }
  /** Version : +1 à chaque réécriture ; ✓ valide celle-ci (accept { rev }). */
  rev?: number
  /** Tâche récurrente en cours : la portée convenue pour son prochain passage (son titre alors), si elle change. */
  next?: { title: string }
  /** Chaque passage (le plus récent en premier, 30 au plus) : unique ou récurrente. Les anciens { at, ok, note } restent lisibles. */
  runs?: AutoRun[]
  /** Nombre total de passages (jamais plafonné). */
  runCount?: number
  /** Jetons consommés, tous passages confondus. */
  tokens?: number
  /** Mise en pause par l'utilisateur : le runner la saute (waiting 'paused'). */
  paused?: boolean
  /** Départ immédiat demandé : attend seulement la machine, sans répéter le bouton de départ. */
  runRequested?: boolean
  /** Validée à cet instant (début du remplissage de la page auto). */
  acceptedAt?: number
}

/** Un passage d'une automatisation : at = fin, startedAt = début. */
export interface AutoRun {
  at: number
  startedAt: number
  ok: boolean
  note?: string
  tokens?: number
  files?: number
  sessionId?: string
}
/** Un fichier produit ou modifié par un passage. abs : chemin absolu sur la machine (page fichier). */
export interface AutoOutputFile {
  path: string
  abs: string
  status: 'A' | 'M' | 'D' | 'R'
  add: number
  del: number
}
/** GET /api/auto/:id/runs/:at — ce qu'un passage a fait et produit. images : chemins servis par /api/auto/:id/blob?path=. */
export interface AutoRunDetail {
  run: AutoRun
  report?: string
  message?: string
  files: AutoOutputFile[]
  links: string[]
  images: string[]
  /** Timer ou job : les lignes de journal du passage. */
  log?: string
}
/** GET /api/auto/:id — l'historique d'une automatisation (tâche, timer ou job). */
export interface AutoDetail {
  id: string
  /** Le plus récent en premier. */
  runs: AutoRun[]
  /** Jetons du passage en cours. */
  liveTokens?: number
  machine: string
}

/** Un choix de conversation : son libellé et le message envoyé quand on le touche. */
export interface AutoSuggestion {
  label: string
  text: string
}

export interface OptimizerLine {
  who: 'user' | 'auto'
  text: string
  at: number
  /** Réponse qui a réécrit la tâche : les champs changés. */
  changed?: OptimizerField[]
  /** Suggestions pour répondre à cette question, jamais des commandes de création ou de validation. */
  suggestions?: AutoSuggestion[]
}

/** next : la portée du prochain passage (convenue pendant qu'elle tourne). */
export type OptimizerField = 'title' | 'why' | 'est' | 'priority' | 'heavy' | 'kind' | 'repo' | 'prompt' | 'notBefore' | 'window' | 'every' | 'next'

/** Réponse de POST /api/optimizers/:id/talk : la réponse à afficher (et lire), la tâche telle qu'elle est maintenant. */
export interface OptimizerTalkReply {
  reply: string
  item?: Optimizer
  changed: OptimizerField[]
  /** Pas de modèle (échec, limite) : rien n'a changé, la question n'est pas gardée. */
  failed?: boolean
}

/** La machine vue par la bande auto : charge, mémoire libre, et ce qui retient une tâche acceptée (null : libre). */
export interface AutoMachine {
  load: number
  cpus: number
  freeGb: number
  wait: 'busy' | 'load' | 'ram' | null
}

export interface Snapshot {
  version: number
  now: number
  machines: Machine[]
  projects: Project[]
  sessions: Session[]
  h24: H24Activity[]
  conversations: ConversationSummary[]
  conversationCounts: { total: number; pending: number; byProject: Record<string, number> }
  /** Classement en cours (lots restants), pour l'afficher. */
  classifier: { running: boolean; queued: number; lastError?: string }
  /** La conversation avec weevils, l'orchestrateur (sa propre session Claude, cachée des projets). */
  main: Message[]
  mainWorking: boolean
  /** Réglages connus de la session de l'orchestrateur, et si on peut lui envoyer des commandes (/model…). */
  mainSettings?: SessionSettings
  mainHasScreen: boolean
  mainQueued: number
  /** Devil mode : modèle branché (DEVIL_API_URL) et réponse en cours. */
  devil: { enabled: boolean; working: boolean }
  /** Ce qui est branché (server/setup.ts) : les bulles renvoient vers weevboss quand un réglage manque. */
  setup?: { claude: boolean; voice: boolean; dictation: boolean; github: boolean; welcomed: boolean }
  /** Premiers pas (shared/tour.ts, server/tour.ts). */
  tour?: Tour
  /** Repos épinglés au fil des projets (présents même sans session). */
  pinnedRepos: string[]
  /** Nombre de souvenirs (server/memory.ts) ; la liste se lit avec GET /api/memory. Absent hors machine principale (pas de mémoire). */
  memoryCount?: number
  /** Tâches du h24 proposées, en attente, en cours ou finies récemment (server/optimizers.ts). Les refusées n'y sont pas. */
  optimizers?: Optimizer[]
  /** La machine vue par la bande auto (server/optimizers.ts), sur la machine principale. */
  autoMachine?: AutoMachine
  /** « Pour toi » (server/foryou.ts), sur la machine principale : révision du flux et nombre d'items pas encore vus. Le flux se lit avec GET /api/foryou. */
  foryou?: ForYouMark
  /** Relais Codex pendant la limite d'usage de Claude (server/relay.ts). */
  relay?: RelayView
  /** Un tour de propositions est en cours (la bande auto montre une place qui se remplit). */
  autoRound?: { busy: boolean }
  /** Réglages de l'utilisateur utiles à l'app (fichier de config du serveur). */
  /** siteKey : clé des pages statiques des repos (/api/site/<clé>/<repo>/), pour le navigateur intégré sans domaine de preview. */
  config: { userName: string; exposeDomain: string; publicHost: string; authors?: Author[]; siteKey?: string }
}

export interface SessionDetail {
  session: Session
  messages: Message[]
}

/** Une question posée depuis la vue d'un fichier ou un fil de conversation : le mot ou la sélection tapés, et ce qui les entoure. */
export interface ExplainRequest {
  mode: 'explain' | 'usage' | 'ask'
  /** file : vue d'un fichier (défaut) ; conv : fil d'une session ou de weevboss ; memory : page mémoire (path = id du souvenir, vide : toute la mémoire ; le serveur la relit lui-même). */
  kind?: 'file' | 'conv' | 'memory'
  /** Repo du fichier ou de la session (vide pour le fil de weevboss). */
  repo: string
  /** file : chemin du fichier ; conv : vide. */
  path: string
  /** conv : titre de la conversation, outil (claude, codex, weevboss) et projet. */
  title?: string
  tool?: string
  project?: string
  machine?: string
  /** Texte sélectionné (vide : la question porte sur ce qui est affiché). */
  selection: string
  /** file : lignes de la sélection, numérotées à partir de 1 (conv : 0). */
  from: number
  to: number
  /** file : les lignes autour, numérotées (« 12│ code ») ; conv : les messages autour (« [auteur] texte »). */
  around: string
  /** mode ask : la question, écrite ou dictée. */
  question?: string
}

export interface UsageHit {
  path: string
  line: number
  text: string
}

export interface ExplainReply {
  text: string
  /** mode usage : les endroits où le mot apparaît dans le repo. */
  hits?: UsageHit[]
  /** La demande était une action : transmise au vrai weevboss (sa réponse arrive dans son fil). */
  forwarded?: boolean
}
