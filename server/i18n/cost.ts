// The cost optimiser (server/cost.ts): its automation's name, the lines it posts in « for you », its proposals, the
// day's audit and the report of each run.
import { defineMessages } from '../i18n.ts'
import type { Why } from '../cost.ts'

const n = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1)} M` : `${Math.round(x / 1e3)} k`)

export default defineMessages({
  fr: {
    title: 'Optimiseur de coûts',
    seedWhy: 'Mesure les jetons de chaque session, sous-agent, automatisation et appel interne, compacte les sessions au repos trop lourdes, arrête les boucles orphelines et propose le reste.',
    today: 'auj.',
    weekday: (d: number) => ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'][d],
    compacted: (k: number) => `J’ai compacté ${k} session${k > 1 ? 's' : ''} au repos`,
    killed: (k: number) => `arrêté ${k} boucle${k > 1 ? 's' : ''} de fond orpheline${k > 1 ? 's' : ''}`,
    cached: (k: number, tokens: string) => `répondu ${k} fois depuis le cache (≈ ${tokens} de jetons évités)`,
    gain: (done: string[], drop: number) => {
      const [first, ...rest] = done
      const head = first.startsWith('J’ai') ? first : `J’ai ${first}`
      const list = rest.length ? `${head}${rest.length > 1 ? ', ' + rest.slice(0, -1).join(', ') : ''} et ${rest.at(-1)}` : head
      return drop > 0 ? `${list}, −${drop} % de jetons sur la dernière heure.` : `${list}.`
    },
    nothing: (last: string) => `Rien à gagner sans risque ce passage (${last} jetons sur la dernière heure).`,
    proposedNote: (k: number) => `${k} proposition${k > 1 ? 's' : ''} dans « pour toi ».`,
    reportHours: (last: string, prev: string) => `Dernière heure : ${last} jetons (heure d’avant : ${prev}).`,
    reportCompacted: (title: string, ctx: string) => `/compact sur « ${title} » (contexte de ${ctx}).`,
    reportFailed: (title: string, why: string) => `« ${title} » non compactée : ${why}`,
    reportKilled: (pid: number, cmd: string) => `Boucle orpheline arrêtée (pid ${pid}) : ${cmd}`,
    circles: (title: string, times: number) => `« ${title} » semble tourner en rond : la même commande ${times} fois en une heure, sans rien écrire. L’arrêter ?`,
    stopIt: 'L’arrêter',
    stopBrief: (title: string, id: string) => `Interrompre la session « ${title} » (${id}), qui répète la même commande sans avancer.`,
    simple: (title: string, model: string) => `« ${title} » fait une tâche simple (lectures, réponses courtes) sur ${model}. Sonnet ferait pareil pour bien moins cher.`,
    toSonnet: 'Passer à Sonnet',
    sonnetBrief: (title: string, id: string) => `Passer la session « ${title} » (${id}) sur Sonnet (/model sonnet).`,
    duplicate: (a: string, b: string) => `« ${a} » et « ${b} » ont l’air de faire la même chose : deux contextes payés pour un travail. Les fusionner ?`,
    mergeThem: 'Les fusionner',
    mergeBrief: (a: string, aid: string, b: string, bid: string) => `Les sessions « ${a} » (${aid}) et « ${b} » (${bid}) font doublon. Demande à « ${b} » de transmettre où elle en est à « ${a} », puis ferme « ${b} » une fois le relais confirmé. Ne touche à rien d’autre.`,
    gone: 'Cette session n’est plus là.',
    auditTitle: 'Audit des jetons du jour',
    auditLead: (total: string, lastHourM: number) => `Aujourd’hui : ${total} jetons (${lastHourM} M sur la dernière heure). Les postes les plus chers :`,
    auditInternal: (tokens: string) => `Appels internes de weevils (curateur, titres, propositions, questions) : ${tokens}, désormais mis en cache quand rien n’a changé.`,
    auditInternalNone: 'Appels internes de weevils : comptés à partir de maintenant (ils n’avaient pas de transcript).',
    auditPlan: 'Chaque tour relit tout le contexte : l’optimiseur compacte désormais toute session au repos au-delà de 150 k, toutes les 30 min.',
    why: (w: Why) => {
      switch (w.k) {
        case 'subagents': return `${w.n} sous-agent${w.n > 1 ? 's' : ''} ${w.model} : ${n(w.tokens)} (${w.turns} tours à ~${n(w.ctx)} de contexte).`
        case 'context': return `Chaque tour relit ~${n(w.ctx)} de contexte (${w.turns} tours, jusqu’à ${n(w.max)}).`
        case 'compacts': return `Déjà ${w.n} compaction${w.n > 1 ? 's' : ''}, toujours lourde.`
        case 'auto': return `Tâche auto sur ${w.model} (${w.turns} tours).`
        case 'heavyModel': return `Sur ${w.model}.`
        case 'polls': return `${w.n} tours d’attente ou de sondage (sleep, until).`
      }
    },
  },
  en: {
    title: 'Cost optimizer',
    seedWhy: 'Measures the tokens of every session, subagent, automation and internal call, compacts heavy sessions at rest, stops orphan loops and proposes the rest.',
    today: 'today',
    weekday: (d: number) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d],
    compacted: (k: number) => `I compacted ${k} idle session${k > 1 ? 's' : ''}`,
    killed: (k: number) => `stopped ${k} orphan background loop${k > 1 ? 's' : ''}`,
    cached: (k: number, tokens: string) => `answered ${k} internal call${k > 1 ? 's' : ''} from the cache (≈ ${tokens} tokens saved)`,
    gain: (done: string[], drop: number) => {
      const [first, ...rest] = done
      const head = first.startsWith('I ') ? first : `I ${first}`
      const list = rest.length ? `${head}${rest.length > 1 ? ', ' + rest.slice(0, -1).join(', ') : ''} and ${rest.at(-1)}` : head
      return drop > 0 ? `${list}, −${drop}% tokens over the last hour.` : `${list}.`
    },
    nothing: (last: string) => `Nothing safe to gain this run (${last} tokens over the last hour).`,
    proposedNote: (k: number) => `${k} proposal${k > 1 ? 's' : ''} in For you.`,
    reportHours: (last: string, prev: string) => `Last hour: ${last} tokens (hour before: ${prev}).`,
    reportCompacted: (title: string, ctx: string) => `/compact on “${title}” (context of ${ctx}).`,
    reportFailed: (title: string, why: string) => `“${title}” not compacted: ${why}`,
    reportKilled: (pid: number, cmd: string) => `Orphan loop stopped (pid ${pid}): ${cmd}`,
    circles: (title: string, times: number) => `“${title}” seems to be going in circles: the same command ${times} times in an hour, nothing written. Stop it?`,
    stopIt: 'Stop it',
    stopBrief: (title: string, id: string) => `Interrupt the session “${title}” (${id}), which repeats the same command without progress.`,
    simple: (title: string, model: string) => `“${title}” is doing a simple task (reads, short answers) on ${model}. Sonnet would do the same for much less.`,
    toSonnet: 'Switch to Sonnet',
    sonnetBrief: (title: string, id: string) => `Switch the session “${title}” (${id}) to Sonnet (/model sonnet).`,
    duplicate: (a: string, b: string) => `“${a}” and “${b}” look like the same job: two contexts paid for one piece of work. Merge them?`,
    mergeThem: 'Merge them',
    mergeBrief: (a: string, aid: string, b: string, bid: string) => `The sessions “${a}” (${aid}) and “${b}” (${bid}) duplicate each other. Ask “${b}” to hand over where it stands to “${a}”, then close “${b}” once the handover is confirmed. Touch nothing else.`,
    gone: 'That session is gone.',
    auditTitle: 'Today’s token audit',
    auditLead: (total: string, lastHourM: number) => `Today: ${total} tokens (${lastHourM} M over the last hour). The most expensive:`,
    auditInternal: (tokens: string) => `weevils’ internal calls (curator, titles, proposals, questions): ${tokens}, now cached when nothing changed.`,
    auditInternalNone: 'weevils’ internal calls: counted from now on (they had no transcript).',
    auditPlan: 'Every turn re-reads the whole context: the optimizer now compacts any idle session above 150k, every 30 min.',
    why: (w: Why) => {
      switch (w.k) {
        case 'subagents': return `${w.n} ${w.model} subagent${w.n > 1 ? 's' : ''}: ${n(w.tokens)} (${w.turns} turns at ~${n(w.ctx)} context).`
        case 'context': return `Every turn re-reads ~${n(w.ctx)} of context (${w.turns} turns, up to ${n(w.max)}).`
        case 'compacts': return `Compacted ${w.n} time${w.n > 1 ? 's' : ''} already, still heavy.`
        case 'auto': return `Auto task on ${w.model} (${w.turns} turns).`
        case 'heavyModel': return `On ${w.model}.`
        case 'polls': return `${w.n} waiting or polling turns (sleep, until).`
      }
    },
  },
})
