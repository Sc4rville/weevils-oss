// The user's own words never come back to them dressed up as weevils' idea.
//
// The memory (server/memory.ts) and what the user told weevboss are context: they help choose what to show, never
// matter to rephrase into a suggestion. A generated proposal that restates one of them, or that opens on « You want… /
// Tu veux… » to hand their own plan back as advice, is not published (server/foryou.ts add / view), and an auto task
// that carries out their own plan says so honestly (server/optimizers.ts parseProposals).

// i18n-ignore: bilingual word lists and openers, recognition only, never displayed
const STOP = new Set(
  (
    'the a an and or but so to of in on at for with from by about into than then there here this that these those it its is are was were be been ' +
    'being have has had do does did not no yes you your yours they their them he his him she her we our us i me my who whom which what when where ' +
    'why how all any some each every more most other such only own same can could will would should may might must shall just also very still already ' +
    'get got make made let lets like want wants wanted would need needs one two out up down over again once whoever people someone something thing ' +
    'le la les un une des du de d l et ou mais donc car ni que qui quoi dont ou au aux en dans sur sous par pour avec sans chez ce cet cette ces ' + // i18n-ignore
    'son sa ses leur leurs ton ta tes mon ma mes notre nos votre vos il elle ils elles on nous vous tu je j me te se lui y est sont etre avoir ' + // i18n-ignore
    'ai as a ont fait faire veut veux voulait voudrait pas plus tres tout tous toute toutes deja encore aussi ici la quand comme si' // i18n-ignore
  ).split(' '),
)

/** The content words of a text: lower case, no accents, no stop words, a light plural/verb ending removed. */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>()
  const plain = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
  for (const raw of plain.match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 3 || STOP.has(raw)) continue
    out.add(stem(raw))
  }
  return out
}

function stem(w: string): string {
  for (const end of ['ing', 'ed', 'es', 's']) {
    if (w.length - end.length < 3 || !w.endsWith(end)) continue
    const s = w.slice(0, -end.length)
    // pinned, pinning → pin; planned → plan
    return end !== 's' && end !== 'es' && /([b-df-hj-np-tv-z])\1$/.test(s) ? s.slice(0, -1) : s
  }
  return w
}

/** Two words are the same when equal, or when one starts the other over at least 5 letters (announce / announcement). */
const same = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a)))

// i18n-ignore: clause boundaries, recognition only
const CLAUSE = /,\s+|\s+(?:and|but|so|while|whereas|et|mais|donc|alors que|tandis que)\s+/iu

/** Sentences, and the clauses inside them: « Your demo is live, and you keep ideas in the repo » is two claims. */
const clauses = (s: string) => sentences(s).flatMap((x) => [x, ...x.split(CLAUSE)])

const sentences = (s: string) =>
  s
    .split(/(?<=[.!?;:])\s+|\n+/u)
    .map((x) => x.trim())
    .filter(Boolean)

function shared(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const x of a) for (const y of b) if (same(x, y)) { n++; break }
  return n
}

/**
 * The source one sentence or clause of `text` restates, or null: at least 3 content words in common, half of the
 * clause's and a quarter of the source sentence's. Compared to each source sentence, so a long message does not match
 * by volume.
 */
export function restated(text: string, sources: readonly string[]): string | null {
  const mine = clauses(text).map(contentWords).filter((w) => w.size >= 3)
  if (!mine.length) return null
  for (const src of sources) {
    for (const part of sentences(src)) {
      const theirs = contentWords(part)
      if (theirs.size < 3) continue
      for (const w of mine) {
        const n = shared(w, theirs)
        if (n >= 3 && n / w.size >= 0.5 && n / theirs.size >= 0.25) return src
      }
    }
  }
  return null
}

// i18n-ignore: clauses that hand the user's own plan back to them, recognition only
const ECHO = new RegExp(
  String.raw`(?:^|[.!?;:,—–]\s*|\b(?:and|but|while|since|so|ok|okay|et|mais|alors|donc|puisque|comme)\s+)` + // i18n-ignore
    String.raw`(?:you(?:'re| are)? (?:still |already )?(?:want(?:ed)?|would like|'d like|wish|plan(?:ned)?|planning|intend(?:ed)?|decided|said|told me|mentioned|asked|were thinking|are thinking|consider(?:ing)?|envisage|enjoy|appreciate|prefer|care about)` +
    String.raw`|you(?:'ve| have) (?:decided|said|mentioned|asked|told me)` +
    String.raw`|your (?:plan|goal|idea|decision|wish) (?:is|was) to` +
    String.raw`|tu (?:veux|voulais|voudrais|souhaites|aimerais|comptes|prévois|prevois|envisages|penses à|apprécies|appr[eé]cies|préfères|pr[eé]f[eè]res|tiens à|as (?:décidé|decide|dit|demandé|demande|mentionné|mentionne|prévu|prevu)|avais (?:dit|demandé|demande|prévu|prevu))` + // i18n-ignore
    String.raw`|ton (?:plan|objectif|idée|idee|souhait) (?:est|était|etait) de)\b`, // i18n-ignore
  'iu',
)

/** Tells the user what they want, said or decided: the shape of a suggestion that repeats them. */
export const echoesUser = (text: string) => ECHO.test(text)

/**
 * Why a generated proposal is the user's own idea handed back to them, or null when it brings something new.
 * title and text are checked together; sources are the memory and what the user said lately.
 */
export function ownIdea(o: { title?: string; text: string }, sources: readonly string[]): { why: 'echo' | 'restates'; source?: string } | null {
  if (echoesUser(o.text) || (o.title && echoesUser(o.title))) return { why: 'echo' }
  const source = restated([o.title, o.text].filter(Boolean).join('. '), sources)
  return source ? { why: 'restates', source } : null
}

// i18n-ignore: the honest opener the model is asked to use for the user's own idea, recognition only
const HONEST = /^\s*(?:your idea|ton id[ée]e)\s*[:,—–-]/iu

/**
 * An auto task as the user may read it: own when its title restates what they said (it carries out their own idea,
 * and says so), and a why that tells them what they want handed back as a reason is dropped. why: null keeps it.
 */
export function ownTask(o: { title: string; why: string }, sources: readonly string[]): { own: boolean; why: string | null } {
  if (HONEST.test(o.why)) return { own: true, why: null }
  if (restated(o.title, sources)) return { own: true, why: '' }
  if (echoesUser(o.why) || restated(o.why, sources)) return { own: false, why: '' }
  return { own: false, why: null }
}
