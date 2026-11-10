// Codex relay while Claude is at (or near) its usage limit (server/relay.ts): the notices, the brief Codex reads to
// write its plan, the brief of the session that carries the plan out, and what weevboss on Codex is told.
import { defineMessages } from '../i18n.ts'

type Win = 'session' | 'week' | undefined

export default defineMessages({
  fr: {
    /** A clock time, for « jusqu'à 18 h ». */
    clock: (h: number, m: number) => (m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`),
    dayClock: (day: string, clock: string) => `${day} ${clock}`,
    until: (when: string) => ` jusqu'à ${when}`,
    /** Ahead of the limit: plans are ready. */
    warnTitle: 'Claude approche de sa limite',
    warn: (percent: number, w: Win) => `t'es à ${percent} % de ${w === 'week' ? 'ta semaine' : 'ta fenêtre 5 h'}, je garde Codex au chaud`,
    warnNoCodex: (percent: number, w: Win) => `t'es à ${percent} % de ${w === 'week' ? 'ta semaine' : 'ta fenêtre 5 h'}, mais Codex ne répond pas : pas de relais prêt`,
    limitTitle: 'limite Claude atteinte',
    nearTitle: (percent: number, w: Win) => `Claude à ${percent} % de ${w === 'week' ? 'sa semaine' : 'sa fenêtre 5 h'}`,
    downTitle: 'Claude ne répond plus',
    takesOver: (until: string) => `Codex prend le relais${until}`,
    plansToCome: (until: string) => `Codex prépare les plans de reprise${until}`,
    /** The thread of weevboss: one sentence. */
    said: (title: string, body: string) => `${title[0].toUpperCase()}${title.slice(1)}, ${body}.`,
    plansTitle: (n: number) => (n > 1 ? `${n} plans de reprise à valider` : 'un plan de reprise à valider'),
    plansSaid: (titles: string[]) =>
      `${titles.length > 1 ? `${titles.length} plans de reprise Codex sont prêts` : 'Un plan de reprise Codex est prêt'} : ${titles.map((x) => `« ${x} »`).join(', ')}. Rien n'est touché tant que tu n'as pas validé.`,
    backSaid: 'Claude est de retour : je reprends sur Claude.',
    /** Sent to a working Claude session when the switch threshold is reached. */
    stop: (until: string) =>
      `Claude arrive à sa limite d'usage${until} et il n'y a aucun délai de grâce. Finis seulement l'étape en cours, n'en commence pas d'autre, laisse le dossier dans un état cohérent (rien à moitié écrit, arrête ou laisse finir ce qui tourne en arrière-plan), puis écris en cinq lignes au plus où tu en es : fait, en cours, reste à faire. Arrête-toi ensuite : Codex prend le relais avec ton compte rendu.`,
    /** Sent to a Claude session the user chose to keep for Claude, once Claude is back. */
    back: (cwd: string) =>
      `Claude est de nouveau disponible. Reprends là où tu t'étais arrêté : ton travail est sur disque dans ${cwd} (git status, git diff), relis tes derniers messages, relance ce qui tournait en arrière-plan, puis finis la tâche ; si elle était déjà finie, dis-le en une phrase.`,
    why_limit: "arrêtée par la limite d'usage de Claude",
    why_near: "arrêtée juste avant la limite d'usage de Claude",
    why_down: "arrêtée parce que l'API de Claude ne répond plus",
    why_running: 'encore au travail sur Claude, qui approche de sa limite (elle peut être coupée à tout moment)',
    none: '(rien)',
    /** What Codex reads, read-only, to write its plan. `marker` first: weevils hides such one-shot runs. */
    plan: (o: { marker: string; why: string; cwd: string; file: string; title: string; ask: string; last: string; replies: string; steps: string; background: string; git: string; auto: boolean; previous?: string; note?: string }) =>
      `${o.marker} Tu prépares la reprise d'une session Claude Code (« ${o.title} »), ${o.why}. Tu ne modifies RIEN pour l'instant : tu es en lecture seule, tu lis le contexte et tu écris un plan que l'utilisateur validera.\n\n` +
      `Dossier de travail : ${o.cwd}\n` +
      `Transcript complet de la session (JSONL, un événement par ligne ; la fin compte le plus, par exemple tail -n 200) : ${o.file}\n\n` +
      `Demande d'origine :\n${o.ask}\n\n` +
      `Dernier message de l'utilisateur :\n${o.last}\n\n` +
      `Dernières réponses de l'agent :\n${o.replies}\n\n` +
      `Ses dernières actions :\n${o.steps}\n\n` +
      `Travail d'arrière-plan (sous-agents, étapes de workflow, commandes) lancé par la session, avec son état : il s'arrête avec elle et fait partie de la reprise :\n${o.background}\n\n` +
      `git, vu par weevils :\n${o.git}\n\n` +
      (o.auto ? `C'est une tâche de fond de weevils : elle travaille seule dans ce worktree, sur sa branche locale, sans rien pousser ni publier.\n\n` : '') +
      (o.previous ? `Ton plan précédent :\n${o.previous}\n\n` : '') +
      (o.note ? `L'utilisateur demande cet ajustement, à intégrer au plan :\n${o.note}\n\n` : '') +
      `Lis le transcript, git status, git diff et les fichiers touchés. Puis réponds uniquement par le plan, en français, 25 lignes au plus, en quatre parties titrées « Fait », « Reste », « Risques » et « Ce que je compte faire » (des étapes concrètes, dans l'ordre). Si le travail était déjà fini, dis-le simplement.`,
    /** The first message of the Codex session that carries the plan out (signed weevboss). */
    go: (o: { why: string; cwd: string; file: string; title: string; plan: string; note?: string; auto: boolean }) =>
      `Tu prends le relais d'une session Claude Code (« ${o.title} »), ${o.why}. Le plan de reprise ci-dessous est validé : exécute-le. ` +
      `Avant de toucher à quoi que ce soit, relis l'état réel : git status et git diff dans ${o.cwd}, et la fin du transcript de la session (${o.file}). ` +
      `Ne refais pas ce qui est déjà fait, relance ce qui tournait en arrière-plan si le plan le prévoit, et garde les règles que la session suivait. ` +
      (o.auto ? `C'est une tâche de fond : reste dans ce worktree et sur sa branche, ne pousse rien, ne publie rien, ne dépense rien. ` : '') +
      (o.note ? `Ajustement demandé par l'utilisateur : ${o.note} ` : '') +
      `Termine par un résumé de trois lignes.\n\nPlan validé :\n${o.plan || '(aucun plan écrit : fais-le toi-même en lisant le contexte, puis exécute-le)'}`,
    /** Hidden block joined to the first message weevboss on Codex receives. */
    bossIn: (why: string, until: string, thread: string, unanswered: boolean) =>
      `tu es weevboss, sur Codex pendant que Claude est indisponible (${why}${until}) : même rôle, mêmes consignes (AGENTS.md de ce dossier), même commande weevils. Les derniers échanges du fil, pour le contexte : ${thread || '(aucun)'}` +
      (unanswered ? ` — le dernier message de l'utilisateur n'a pas eu de réponse à cause de la coupure : réponds-y maintenant` : ''),
    /** Hidden block joined to the first message weevboss on Claude receives once it is back. */
    bossUnanswered: "le dernier message de l'utilisateur dans le fil n'a pas eu de réponse à cause de la coupure de Claude : réponds-y maintenant",
    bossBack: (thread: string) => `pendant que tu étais à ta limite d'usage, Codex a répondu à ta place dans ce fil. Ce qui s'est dit : ${thread || '(rien)'}`,
    bossWhy_limit: "limite d'usage atteinte",
    bossWhy_near: "limite d'usage presque atteinte",
    bossWhy_down: "l'API ne répond plus",
    noCodex: "Codex n'est pas installé ou pas connecté sur cette machine",
    noPlan: 'aucun plan de reprise pour cette session',
    planFailed: "Codex n'a pas pu écrire le plan",
    noJail: 'pas de prison bwrap sur cette machine : la tâche attend Claude',
  },
  en: {
    clock: (h: number, m: number) => `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`,
    dayClock: (day: string, clock: string) => `${day} ${clock}`,
    until: (when: string) => ` until ${when}`,
    warnTitle: 'Claude is close to its limit',
    warn: (percent: number, w: Win) => `you're at ${percent}% of ${w === 'week' ? 'your week' : 'your 5-hour window'}, I'm keeping Codex warm`,
    warnNoCodex: (percent: number, w: Win) => `you're at ${percent}% of ${w === 'week' ? 'your week' : 'your 5-hour window'}, but Codex does not answer: no relay ready`,
    limitTitle: 'Claude limit reached',
    nearTitle: (percent: number, w: Win) => `Claude at ${percent}% of its ${w === 'week' ? 'week' : '5-hour window'}`,
    downTitle: 'Claude stopped answering',
    takesOver: (until: string) => `Codex takes over${until}`,
    plansToCome: (until: string) => `Codex is preparing the takeover plans${until}`,
    said: (title: string, body: string) => `${title[0].toUpperCase()}${title.slice(1)}, ${body}.`,
    plansTitle: (n: number) => (n > 1 ? `${n} takeover plans to approve` : 'a takeover plan to approve'),
    plansSaid: (titles: string[]) =>
      `${titles.length > 1 ? `${titles.length} Codex takeover plans are ready` : 'A Codex takeover plan is ready'}: ${titles.map((x) => `“${x}”`).join(', ')}. Nothing is touched until you approve.`,
    backSaid: 'Claude is back: I carry on with Claude.',
    stop: (until: string) =>
      `Claude is about to hit its usage limit${until} and there is no grace period. Finish only the step you are on, start no other, leave the folder in a consistent state (nothing half written; stop or let finish what runs in the background), then write in five lines at most where you stand: done, in progress, left to do. Then stop: Codex takes over with your report.`,
    back: (cwd: string) =>
      `Claude is available again. Pick up where you stopped: your work is on disk in ${cwd} (git status, git diff), reread your last messages, restart what was running in the background, then finish the task; if it was already done, say so in one sentence.`,
    why_limit: "stopped by Claude's usage limit",
    why_near: "stopped just before Claude's usage limit",
    why_down: "stopped because Claude's API no longer answers",
    why_running: 'still working on Claude, which is close to its limit (it may be cut off at any moment)',
    none: '(nothing)',
    plan: (o: { marker: string; why: string; cwd: string; file: string; title: string; ask: string; last: string; replies: string; steps: string; background: string; git: string; auto: boolean; previous?: string; note?: string }) =>
      `${o.marker} You are preparing the takeover of a Claude Code session ("${o.title}"), ${o.why}. You change NOTHING for now: you are read-only, you read the context and write a plan the user will approve.\n\n` +
      `Working folder: ${o.cwd}\n` +
      `Full transcript of the session (JSONL, one event per line; the end matters most, for example tail -n 200): ${o.file}\n\n` +
      `Original request:\n${o.ask}\n\n` +
      `The user's last message:\n${o.last}\n\n` +
      `The agent's last replies:\n${o.replies}\n\n` +
      `Its last actions:\n${o.steps}\n\n` +
      `Background work (subagents, workflow steps, commands) started by the session, with its state: it stops with the session and is part of the takeover:\n${o.background}\n\n` +
      `git, as weevils sees it:\n${o.git}\n\n` +
      (o.auto ? `This is a weevils background task: it works alone in this worktree, on its local branch, pushing and publishing nothing.\n\n` : '') +
      (o.previous ? `Your previous plan:\n${o.previous}\n\n` : '') +
      (o.note ? `The user asks for this adjustment, to fold into the plan:\n${o.note}\n\n` : '') +
      `Read the transcript, git status, git diff and the touched files. Then answer with the plan only, in English, 25 lines at most, in four titled parts: "Done", "Left", "Risks" and "What I intend to do" (concrete steps, in order). If the work was already finished, just say so.`,
    go: (o: { why: string; cwd: string; file: string; title: string; plan: string; note?: string; auto: boolean }) =>
      `You take over a Claude Code session ("${o.title}"), ${o.why}. The takeover plan below is approved: carry it out. ` +
      `Before touching anything, reread the real state: git status and git diff in ${o.cwd}, and the end of the session's transcript (${o.file}). ` +
      `Do not redo what is done, restart what was running in the background if the plan says so, and keep the rules the session followed. ` +
      (o.auto ? `This is a background task: stay in this worktree and on its branch, push nothing, publish nothing, spend nothing. ` : '') +
      (o.note ? `Adjustment asked by the user: ${o.note} ` : '') +
      `End with a three-line summary.\n\nApproved plan:\n${o.plan || '(no plan was written: write it yourself from the context, then carry it out)'}`,
    bossIn: (why: string, until: string, thread: string, unanswered: boolean) =>
      `you are weevboss, on Codex while Claude is unavailable (${why}${until}): same role, same instructions (AGENTS.md of this folder), same weevils command. The last exchanges of the thread, for context: ${thread || '(none)'}` +
      (unanswered ? ` — the user's last message got no answer because of the cut: answer it now` : ''),
    bossUnanswered: "the user's last message in the thread got no answer because Claude was cut off: answer it now",
    bossBack: (thread: string) => `while you were at your usage limit, Codex answered in your place in this thread. What was said: ${thread || '(nothing)'}`,
    bossWhy_limit: 'usage limit reached',
    bossWhy_near: 'usage limit almost reached',
    bossWhy_down: 'the API no longer answers',
    noCodex: 'Codex is not installed or not signed in on this machine',
    noPlan: 'no takeover plan for this session',
    planFailed: 'Codex could not write the plan',
    noJail: 'no bwrap jail on this machine: the task waits for Claude',
  },
})
