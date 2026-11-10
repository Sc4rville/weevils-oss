// Messages of server/infra.ts: advice drawn from the machine's real measurements.
import { defineMessages } from '../i18n.ts'

const frList = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} et ${xs[xs.length - 1]}` : xs[0] ?? '')
const enList = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] ?? '')
const frDur = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${String(min % 60).padStart(2, '0')}` : ''}` : `${min} min`)
const enDur = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`)

export default defineMessages({
  fr: {
    memPct: (n: number) => `${n} % de mémoire`,
    saturated: (n: number, culprits: string[], peak: string, at: string) =>
      `Tu as saturé ${n === 1 ? 'une fois' : `${n} fois`} aujourd’hui${culprits.length ? ` pendant ${frList(culprits)}` : ''} (pic ${peak} à ${at}).`,
    noSwap: (gb: number) => `Aucun swap : ajoute ${gb} Go, un pic de mémoire ralentira au lieu de tuer une session.`,
    swapHigh: (pct: number) => `Swap utilisé à ${pct} % : la mémoire manque, la machine ralentit.`,
    memHigh: (min: number) => `Mémoire au-dessus de 85 % pendant ${frDur(min)} aujourd’hui.`,
    cpuHigh: (pct: number) => `CPU à ${pct} % en moyenne aujourd’hui : passe au palier supérieur.`,
    diskHigh: (pct: number, freeGb: number) => `Disque plein à ${pct} % : plus que ${freeGb} Go libres.`,
    perSession: (mb: number, cpu: number, cap: number) => `Une session prend ~${mb} Mo et ~${cpu} % d’un cœur : ici, tu en tiens ~${cap}.`,
    forN: (n: number, vcpu: number, ram: number) => `Pour ${n} sessions, il faut ${vcpu} vCPU / ${ram} Go.`,
    memTrend: (pts: number, days: number) => `Mémoire moyenne en hausse : +${pts} points en ${days} jours.`,
    diskFull: (days: number) => `Disque plein dans ~${days} jours au rythme actuel.`,
    upgrade: (plan: string, vcpu: number | null, ram: number | null, price: number, delta: number | null, cur: string) =>
      `Palier au-dessus : ${plan}${vcpu && ram ? ` (${vcpu} vCPU / ${ram} Go)` : ''}, ${price} ${cur}/mois${delta != null ? `, +${Math.round(delta * 100) / 100} ${cur}` : ''}.`,
    noToken: 'pas connecté',
    expired: 'jeton expiré, ouvre claude une fois',
  },
  en: {
    memPct: (n: number) => `${n}% memory`,
    saturated: (n: number, culprits: string[], peak: string, at: string) =>
      `You saturated ${n === 1 ? 'once' : `${n} times`} today${culprits.length ? ` during ${enList(culprits)}` : ''} (peak ${peak} at ${at}).`,
    noSwap: (gb: number) => `No swap: add ${gb} GB, a memory spike will slow down instead of killing a session.`,
    swapHigh: (pct: number) => `Swap ${pct}% used: memory is short, the machine slows down.`,
    memHigh: (min: number) => `Memory above 85% for ${enDur(min)} today.`,
    cpuHigh: (pct: number) => `CPU at ${pct}% on average today: move to the next tier.`,
    diskHigh: (pct: number, freeGb: number) => `Disk ${pct}% full: only ${freeGb} GB left.`,
    perSession: (mb: number, cpu: number, cap: number) => `A session takes ~${mb} MB and ~${cpu}% of a core: this machine holds ~${cap}.`,
    forN: (n: number, vcpu: number, ram: number) => `For ${n} sessions you need ${vcpu} vCPU / ${ram} GB.`,
    memTrend: (pts: number, days: number) => `Average memory rising: +${pts} points over ${days} days.`,
    diskFull: (days: number) => `Disk full in ~${days} days at the current pace.`,
    upgrade: (plan: string, vcpu: number | null, ram: number | null, price: number, delta: number | null, cur: string) =>
      `Next tier: ${plan}${vcpu && ram ? ` (${vcpu} vCPU / ${ram} GB)` : ''}, ${price} ${cur}/month${delta != null ? `, +${Math.round(delta * 100) / 100} ${cur}` : ''}.`,
    noToken: 'not signed in',
    expired: 'token expired, open claude once',
  },
})
