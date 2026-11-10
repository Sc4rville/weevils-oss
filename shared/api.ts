// Contrat entre weevilsd (VPS) et l'app. Horodatages en millisecondes, compteurs toujours dérivés côté app.

export type Tool = 'claude' | 'codex'
export type SessionStatus = 'working' | 'needs_user' | 'idle' | 'done'

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
}

/** Qui peut signer un message dans une session, à part l'utilisateur : weevboss et les agents externes (config du serveur). */
export interface Author {
  id: string
  name: string
  /** Couleur CSS de ses messages ; vide = le violet de weevboss. */
  color: string
}

export interface Subagent {
  id: string
  label: string
  activity: string
  status: 'working' | 'done'
  startedAt: number
  endedAt?: number
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
  lastMessage?: string
  messageCount: number
  settings?: SessionSettings
  /** Messages reçus pendant que la session travaille, pas encore traités. */
  queued: number
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
  /** Repos épinglés au fil des projets (présents même sans session). */
  pinnedRepos: string[]
  /** Réglages de l'utilisateur utiles à l'app (fichier de config du serveur). */
  config: { userName: string; exposeDomain: string; publicHost: string; authors?: Author[] }
}

export interface SessionDetail {
  session: Session
  messages: Message[]
}

/** Une question posée depuis la vue d'un fichier ou un fil de conversation : le mot ou la sélection tapés, et ce qui les entoure. */
export interface ExplainRequest {
  mode: 'explain' | 'usage' | 'ask'
  /** file : vue d'un fichier (défaut) ; conv : fil d'une session ou de weevboss. */
  kind?: 'file' | 'conv'
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
