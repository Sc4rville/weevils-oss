# For you — plan

Written on November 10, 2026. Branch `feat/foryou`. Starts from the draft of an earlier session
(`origin/feat/foryou-draft`, `docs/foryou/plan.md`): its skeleton is kept (typed items in a server module, pacing
computed by the server, « weevboss · for you » at the top, a participant filter, actions that slide out of the
stream), re-checked against `main` and completed where it was thin (history, media, cost, what weevboss really is).

The brief, in one line: next to weevboss, a stream that makes the user's « company of agents » **readable**
(what happens, playfully), **actionable** (a lot can be done from it), a place to **learn** (go further on what the
agents touch) and **hard to put down** (a sensory, living factory) — in weevils' own look: full bands, colour only,
no border. The numbered categories of the paper sketch are content types; their names are never shown.

In the code the feature is called **for you** (`foryou`): « feed » already names the home list of project bands.

## 1. What is true on main today (checked)

- **No history anywhere.** Everything is current state rebuilt from transcripts; a session that finished, an alert
  that resolved, a mail that came in leave no trace weevils can list. `Snapshot.main` is the last 40 messages only.
  → the stream needs its own persisted store.
- **The whole snapshot is re-sent to every device on every change** (SSE carries a version number only).
  → the stream travels on its own route; the snapshot carries a revision and an unseen count, nothing else.
- **weevboss is purely reactive**: a real Claude Code session woken only by a message. It never posts on its own, and
  every wake-up is a full turn on the subscription. → its « words » in the stream are written by weevilsd with the
  cheap headless helpers (`server/fast.ts`), in its voice, and weevboss itself gets a verb to post when it wants to.
- **Mail bodies are not kept** (`mail.json` holds ids only) and the sender's address is lost after the reply.
- **No media route**: nothing serves an image or a video from a path, no video MIME type, no `Range` (iOS will not
  play a video without it), no `<video>` in the app. Media on disk is 97 % exhaust (frame dumps, worktree copies):
  scanning folders would be slop by construction.
- **Proposals exist**: `snap.optimizers` (state `proposed`, accept/refuse routes) and the personal tips
  (`personalTips()`, cards with an action). Another session is reworking optimizer proposals right now: the stream
  only reads them and calls their routes.
- **Real volumes** (2–3 days of use): 10–28 real sessions a day (the richest source), ~40 % of all sessions are test
  probes (`isTestBrief`, headless) and must be filtered, ~1 outside mail a day, 0–3 proposals per 6 h round, memory
  still empty on the real instance. Padding thin signal would be slop: the stream is **finite** and says when the
  user is up to date.
- **Gestures already taken**: the home stack swipes left to the repos, every page swipes right to go back. A carousel
  must scroll natively and stop the pointer from reaching them.
- **House rules that bind**: every string in a catalog (fr + en), four themes (light, dark, zen, graphite), flat
  bands, sharp corners, no shadow, character icons, nothing moves under the finger, `bands.test.tsx` (sending never
  opens the full-screen thread).

## 2. The stream

### 2.1 Items (`shared/foryou.ts`)

One type, `ForYouItem { id, kind, tone, at, who, projectId?, sessionId?, title?, text, body?, media?, cards?,
actions?, reply?, open?, more?, seen?, live? }`. `who` is the speaker (weevboss, an author id, `session`,
`weevils`) and the participant filter. `tone` picks the colour family.

| kind | what it shows | where it comes from | what can be done |
|---|---|---|---|
| `media` | a render, a clip, a screenshot the user asked for | **published on purpose**: `weevils show <file> "caption"` from any session or weevboss; files cited in the last message of a finished turn | play / look full screen, reply to the session, open it |
| `boss` | weevboss as a readable CEO: what was sent, what came back, sometimes a thought tied to the user's goals, sometimes actions | `weevils post "…"` (weevboss itself) and the **digest** written by weevilsd in its voice from what really happened since the last one + the memory | reply (a real message to weevboss, with the post as hidden context), launch a suggested action, open the thread |
| `mail` | a discreet line: who, a short « I did this » | the mail bridge, recorded at dispatch (author, subject, text, target) | unfold the whole mail in place, reply by mail |
| `proposals` | suggested automations, as a split carousel when there are several | `snap.optimizers` (proposed) + personal tips with an action | ✓ / × per card; the card leaves sideways |
| `session` | project · session · what it did (green), what it asks (amber), why it stopped (alert) | status transitions recorded with the last assistant message; one item per session, replaced by its next turn | reply inline, open the real conversation, resume when cut |
| `improve` | a way for weevils to serve this user better, drawn from how they use it | generated (rarely) from usage patterns, machine advice and tips | « do it » (a brief to weevboss), reply, dismiss |
| `alert` | what needs the user now, sober | live state: sessions waiting or cut, a usage window nearly full, a saturated machine, a failed auto task | open the place where it is solved; it leaves by itself once solved |
| `insight` | bold text, like a page you learn from: something true about the stack or the tools the agents are using | generated per repo from what is really in it (dependencies, languages, recent commits), cached | « more »: a longer answer unfolds in place |
| `milestone` | a big number or a first time, in colour-shifting type | deterministic counters (turns delivered today, commits, first auto task done…) | — |
| `stat` | where things stand, as bars: a usage window, today's turns per project, the auto queue, a machine | plain counters from the snapshot, usage and infra (no model) | open the place it speaks of |

Sketch → kinds: 1 media · 2 boss · 3 mail · 4 proposals · 5 session · new idea: improve · 6 alert · 7 insight,
milestone and stat.

Added by the user while step 1 was being built:

- **Voice messages.** A word from weevboss or from an outside actor can be listened to: the item carries a play
  glyph and a moving wave, a tap reads it aloud. Every speaker has **its own voice**, always the same one (weevboss
  keeps the app's voice; each author gets one from the available voices, by a stable pick, overridable in its
  declaration). It reuses `GET /api/speak/stream?text=…&voice=…`; nothing is synthesised before the tap. Some items
  are voice-first (the digest's thought, a short mail): the wave leads and the text sits under it.
- **Figures as shapes.** Bars and small gauges, as their own item (`stat`) and under other items when they say
  « we are here » (a usage window at 71 %, 12 turns delivered of 18 started, the auto queue, a project's share of
  the day). `ForYouGauge { label, value, max, shown, projectId?, hot? }`. They fill when they come into view.

### 2.2 Not slop

- **Media is opt-in by the author**, never scanned. A file enters the stream because an agent published it
  (`weevils show`) or named it in the message that ends its turn. Caption, session and project come with it.
- **One item per session**, not per turn: the newest result replaces the previous one.
- **Test and headless sessions never enter** (`isTestBrief`, headless, sessions under weevils' data, weevboss's own).
- **Generated text is rare, grounded and capped**: it quotes what happened (titles, repos, counts) and is refused
  when it does not parse or repeats an earlier item (same Jaccard test as the optimizers).
- **Insights only state well-established facts** about things really present in the repo; the prompt forbids
  numbers and dates it is not sure of, and « more » lets the user dig.
- **The stream ends.** After the last item, one line says the user is up to date. No infinite filler.

### 2.3 Order and pace (`arrange()`, pure, tested)

Score = freshness × weight of the kind (alert > session question > mail > session result > boss > proposals > media
> improve > insight), unseen before seen. Then a pacing pass: never two items of the same kind in a row when it can
be avoided, a fresh media opens the stream when there is one, the proposals carousel sits around the third place,
one insight or milestone every ~5 items, alerts stay on top. On the device, the order is frozen while a finger is
down or the stream is moving (`isSettled()`); newcomers wait behind a « new » mark at the top instead of pushing
what is being read.

## 3. Server

### 3.1 `server/foryou.ts` — the store and the sources

Class `ForYou(w, deps)`, built like `Optimizers`: JSON file `DATA_DIR/foryou.json` written tmp + rename, capped
(400 items, 14 days), `w.bump()` on change, main machine only (`ORCHESTRATOR`), everything testable without
`index.ts` (injected clock, `sys`, `memory`, `usage`, `infra`).

- **Recorded** (events, persisted): `session` results and questions (hooked where `notifyTransitions()` already sees
  working → idle/done/needs_user and `announceCuts()` sees a cut; the first pass after a restart stays silent, the
  store carries the history), `mail`, `boss`, `media`, `improve`, `insight`, `milestone`.
- **Live** (computed at read time, `live: true`): `alert` and `proposals`. They disappear with their cause.
- State per item: `seen`, `gone` (dismissed or acted on), `moreText`.
- `feed(now, lang)` → `ForYouFeed { rev, items (≤ 60, arranged), pulse }`. `mark()` → `{ rev, unseen }` for the
  snapshot (`Snapshot.foryou?`).
- The result text of a session is its last assistant message (compaction preambles skipped, 600 chars). Remote
  sessions go through `detailAny()`.

### 3.2 Routes (`foryouRoutes`, spread next to the other route tables)

| route | what |
|---|---|
| `GET /api/foryou` | the stream; also tells the curator the app is looking (`lastWanted`) |
| `POST /api/foryou/seen { ids }` | marks items seen (cross-device) |
| `POST /api/foryou/:id/dismiss` | removes an item |
| `POST /api/foryou/:id/act { action, card? }` | runs a button: accept / refuse a card (optimizer or tip), send a boss brief, resume a session |
| `POST /api/foryou/:id/reply { text }` | session → `w.send` ; boss → `sendMain(text, brief quoting the post)` ; mail → a mail to the author in the same thread |
| `POST /api/foryou/:id/more` | insight: a longer answer (`smart`), cached in the item |
| `POST /api/foryou/post` (local only) | `weevils post` |
| `POST /api/foryou/media` (local only) | `weevils show` |
| `GET /api/foryou/media/:id` | the bytes, with `Range`, video MIME types, auth cookie |

### 3.3 Media (`server/foryou-media.ts`)

`weevils show <path> ["caption"]` registers a file: it must exist under the projects roots, the inbox or weevils'
data, be an image or a video by extension and sniffed header, and stay under a size cap (image 25 MB, video 400 MB).
The store keeps `{ id, path, type, bytes, mtime }`; the route serves only registered ids, streams with
`206 Partial Content`, and never follows a path from the request. The calling session is found from `$WV_SESSION` /
the cwd when present, so the item knows its project. Files cited in the closing message of a turn are registered the
same way (same checks, at most 4, dot-directories refused).

### 3.4 weevboss (`server/weevils-cli`, `server/orchestrator.{fr,en}.md`)

Two verbs, documented in both prompts: `weevils post "text" [--action "label::what to do"]…` (a word in the stream,
with optional buttons whose brief comes back to weevboss when tapped) and `weevils show <file> "caption"`. The
prompt tells it when: after dispatching several things, when something is worth the user's eyes, and to ask the
sessions it briefs to `weevils show` their visual results.

### 3.5 The curator (`server/foryou-curator.ts`) — generated content, on a budget

One single-flight loop for everything generated, so the stream is **one** spender:

- runs only when the app asked for the stream in the last 30 minutes and Claude is logged in;
- skips when a Claude usage window is at 85 % or more (`quotas()`), backs off 1 h doubling to 12 h on failure
  (persisted), and never exceeds a daily cap (12 calls, one per tick);
- **digest** (boss, `smart`): at most one per 3 h and only when something happened since the last one (turns
  finished, things sent by weevboss, alerts). JSON `{ text, thought?, actions?[] }`: the recap in weevboss's voice,
  sometimes one sentence that makes the user think, tied to a memory item when there is one, sometimes up to two
  actions;
- **improve** (`smart`): at most one per 12 h, from usage patterns (when and where sessions run, what gets cut,
  what waits), machine advice and unused bricks;
- **insight** (`smart`): at most one per 2 h, one repo at a time among those active today, cached per repo and
  week; **milestones** are plain counters, no model;
- **mail summary** and **session result line** (`haiku`, batched): one short « did this » line each; the raw
  text is the fallback and the stream never waits for them;
- every prompt lives in `server/i18n/foryou-curator.ts` (fr + en); an item keeps the language it was written in and is
  hidden when the app's language differs.

## 4. App

### 4.1 Where it lives

- **Top band**: two small words under the logo row, `weevboss · for you` (the active one in full ink, like
  `.word.on`). The choice is remembered on the device. On « for you », the preview area shows the stream's first
  items as thin coloured strips (speaker · one line), scrollable in place; a tap opens the stream full screen. The
  field below always writes to weevboss. A dot on « for you » says there is something unseen. Sending never opens
  anything (the pinned invariant holds), and the thread preview stays mounted.
- **Full screen** (`Page { kind: 'foryou' }`): its head carries the same two words (« weevboss » closes the page
  and opens the thread in full), then one line of participants scrolling sideways: everything · weevboss · each
  outside author · sessions · media · ideas. One tap isolates a participant; the choice is kept.
- **Open thread** (band expanded): the two words stay, « for you » opens the page.

### 4.2 Look

Every item is a full-width band with its own `--c`; inner zones use `.tone`; nothing has a border, a radius or a
shadow. Colours: result → a green derived from `--fluo` readable in the four themes; question → `--h24` amber;
alert → `.invert` / `--alert`, one line, no giant « ! »; boss → `--agent`; mail → the author's colour, thin;
proposals → the auto palette (`propColors`), **always recognisable by the same trait**: a `+` glyph leading the
title and the ✓ × pair on the right, whatever the form (carousel of 2–3, one wide band, or a band with a reply
line when the proposal is a question); media → edge to edge, capped at 62 dvh, caption on a tone strip of its
context colour (green when it is a result); improve → a slow moving gradient (the one place colour goes wild);
insight → the project's colour, 1.375rem / 800 type; milestone → gradient-clipped type that shifts.

### 4.3 Motion and senses (the factory)

- **The line** at the top of the full-screen stream: a thin strip with what is turning now — stars spinning for
  working agents, counts for « delivered today », « waiting for you », auto tasks. It is the only thing always
  alive.
- Items enter with the house spring, staggered 40 ms for the first six; later ones fade up as they reach the
  screen (once).
- **An action leaves sideways**: accept, launch, dismiss → the band slides out to the right, the next ones close
  the gap (layout spring), a short « sent » flash where it was. Refuse leaves to the left.
- Video plays muted while in view and pauses outside; a tap gives sound and full screen. Images get a slow 1 → 1.03
  drift while in view.
- Unseen items carry the dot and heavier type; they are marked seen after 1.2 s in view.
- A light tap vibration where the device allows it (accept, send). `prefers-reduced-motion` keeps opacity only.
- The stream ends on « up to date », with the time of the last look.

### 4.4 Files

`src/ui/foryou.tsx` (page, items), `src/ui/foryou-top.tsx` (the two words, the preview), `src/ui/foryou-store.ts`
(fetch on `snap.foryou.rev`, optimistic act / dismiss / seen), `src/ui/foryou.css` (prefixed `fy-`),
`src/i18n/foryou.ts`, tests next to them. `AgentBand` gains the words row and the preview sibling; `Page` and
`PageView` gain `foryou` and `media`.

## 5. Steps (each one ends deployed)

1. **Foundation** — contract; store, sources without a model (session, alert, proposals, mail record, boss posts by
   verb), routes, media route and `weevils show` / `post`; app: words, preview, page, the nine renderers, reply,
   act, dismiss, seen. `npm run check`. Blank instance + isolated server on the real data. Deploy.
2. **Curator** — digest, improve, insight, milestones, the two summaries, budget and back-off, language. Tests with
   `fast.ts` mocked. Isolated server on the real data (real model calls, watched). Deploy.
3. **Feel** — the line, entries and exits, video behaviour, unseen, filters, the four themes, wide screens; demo
   world seeded with a stream; screenshots of every kind in light and dark; motion harness on the top-band scenes
   (no jump when switching words). Review by independent readers, fixes. Deploy.
4. **Close** — changelog, weevboss's prompt live, this plan updated with what was actually built.

## State on November 10, 2026 (evening)

Built, on `main`:

- **Step 1, live**: the store and its routes, the media shelf with `Range`, `weevils post` / `weevils show` and
  weevboss's prompt, the two words at the top, the preview, the full-screen stream with its participant filter, a
  renderer per kind, inline replies, actions. Checked on a throwaway server seeded with every kind, then booted on
  the real transcripts (which showed a wall of old cuts at first start: only those under 12 h now get an item).
- **Step 2, merged, live at the next restart of weevilsd**: the curator (`server/foryou-curator.ts`: digest,
  improve, insight and « more », milestones, « where the day stands » bars, one-line mail summaries) on its budget,
  and a voice per speaker (`server/foryou-voice.ts`). Session results are not summarised by a model: the band
  already shows project · title above the closing words.
- **Step 3, live** (app only): voice messages, bars that fill, the rolling counts of the line, exits over « lancé /
  envoyé / écarté », media kept whole, wide screens, the unread dot in the margin.

Changed after the first look on the phone (same evening): a session's result is **one line said in passing**
(`headline()`: no markdown, path, command or machine tag; the curator rewrites it in the first person when the budget
allows), the whole report and the reply unfold under it; the stream is **newest first**, so news always comes in
at the top (held behind « n new » while reading; only system alerts sit above); turns that ended in the last 24 h
before the stream listened get their item; the curator makes no call before the usage figures are known (one digest
was written blind at a start, at 90 % of the week).

Not checked yet, to do on a device or with real traffic:

- the texts the curator writes (no real model call was made while building: the prompts are untested on real
  data — read the first digests, insights and improve ideas and tune `server/i18n/foryou-curator.ts`);
- « resume » from the stream and a reply by mail through the real bridge;
- on an iPhone: the carousel against the page's swipe-back, muted inline video and its pause out of view, the
  audio of a voice message (unlocking on tap, the logo and an item silencing each other), the tap vibration;
- a running weevboss conversation only learns `weevils post` / `weevils show` at its next conversation.

Known rough edges: an image has no height until it loads (the server sends no dimensions), so what is below
shifts once; the « sent » band is white in the dark theme; the line wraps on two lines with four counts; a card
leaving the carousel shows no word; no per-author voice override; a session's `weevils post` is signed weevboss;
the stream is main-machine only (media of a secondary machine cannot be shown); the demo world of
`weevils-content` is not seeded with a stream yet.

### Handover (November 10, 2026, Claude at its weekly limit — Codex takes over)

Done and live: human tone (curator prompts, alerts, figures, milestones), question cards read by a light model
(title + clear question + option buttons sent to the session; « not really a question » becomes a result), pace
(never twice the same sort in a row, newest first within 4 places), history of 4 days (backfill 40 per pass,
stream up to 160), auto tasks started / finished as items, curator modes: full (Claude < 85 %), relay (everything
through `codex exec`, `relay()` in `server/fast.ts`, 30 calls a day), lean (haiku only up to 98 %, 16 a day).

Left: commits and deploys as items (git log of active repos, free); new proposals as an event; the weevboss band
asked by the user — logo a little higher and a taller thread preview when folded, and weevboss full screen must be the
same frame as « pour toi » full screen (same head « weevboss · pour toi », whole screen, no jump when switching):
today the open band is smaller than the page. Check with iPhone screenshots (folded, full screen, switching).

## 6. Checks

- `npm run check` (typecheck app + server, i18n, shell lint, tests) before every merge.
- Pure tests: `arrange()`, the store (cap, replace-per-session, gone/seen), media registration (path jail, sniff,
  Range arithmetic), curator (budget, back-off, parse, dedup), routes' trust (`post` and `media` local only).
- UI tests: the words row keeps `bands.test.tsx` green; preview and page render each kind; act → the item leaves;
  reply goes to the right route.
- Live: throwaway server from the worktree with its own `HOME`/`TMUX_TMPDIR`/ports (blank), then the same against
  the real data read-only-ish (own tmux socket, no weevboss), then a blank Docker instance (`FRESH_NAME=weevils-foryou`).
  Never `tmux kill-server`, never the live instance for a test.
- Deploy: rebase on `main`, fast-forward `main`, `heavy npm run build`, `systemctl --user restart weevilsd`, push.

## 7. Risks

- **Parallel work on main** (auto proposals, memory, softwares, fluidity, language, usage): small surface in shared
  files (`AgentBand`, `App.tsx`, `core.ts`, `index.ts`, `weevils-cli`), rebase before each step, never restore an
  older version of a file.
- **Cost**: the curator is a new spender; budget, usage gate and « only when looked at » are part of step 2, not an
  afterthought.
- **Privacy**: mail bodies and results now persist in `foryou.json` (mode 600, same place as the rest); nothing of
  it goes into push notifications or the snapshot.
- **Height of the top band** when switching words: both previews share the same box, so nothing below moves.
- **A running weevboss conversation** only learns the new verbs at its next conversation; the digest does not
  depend on it.

### Codex continuation — November 10, 2026

This section supersedes the earlier “left / untested” notes where explicitly covered below.

- Mixed mail/result batches now parse the entire batch, including batches containing only session results.
  Generated lines retain up to 220 characters, matching the prompt, rather than cutting them at 120.
- Model-written question buttons carry a fingerprint of their question and choices. A stale button is refused
  even if the same session is waiting on a different question. Late model answers cannot annotate a newer question.
  Choices still go only to that session; no live user session was answered during verification.
- Model budget is reserved after asynchronous preparation. “More” rechecks the current route after reading repo
  facts, uses its own mode rather than mutating the loop's mode, and shares each mode's persisted daily cap.
- Recent Git commits enter without a model: at most 12 commits per active local repo, 12 repos per pass, four-day
  horizon, every four minutes. Commit identities persist across restarts. Newly proposed auto tasks leave a
  history event as well as their live accept/refuse card.
- Vite writes `dist/build.json` with the commit and build time. The running server records that served build once
  per commit as a deployment event. This covers this weevils instance; deployments of other projects are not
  inferred from a commit message or an unverified session claim.
- The folded preview is 42dvh (formerly 34dvh), with less padding above the logo. The open boss thread uses a
  portal outside the transformed home stack, the same viewport and word row geometry as the for-you page.
  The composer retains voice input while the large logo is hidden in full screen. The stream overlays the thread
  when switching, and returning to the boss closes the stream.

Verification: full `npm run check`; regression cases for zero-mail and mixed batches, relay routing and persisted
counts, route changes during fact loading, competing requests for the last budget slot, stale questions and session
routing, and deployment identity across restart. Real Codex generations were reviewed against two recent session
reports and two real attention messages: one trust question with two choices, one non-question. Generated lines
were checked again after the 220-character fix. These were read-only probes, not replies to those sessions.
Chromium desktop (1280×800) and mobile (390×844) checks run against an isolated demo server with its own HOME,
tmux socket and ports (4291/4292), without production credentials. Screenshots and frame checks cover folded,
boss full screen, stream full screen and both switches; no JavaScript errors. Actual iPhone/Safari audio,
keyboard and swipe behaviour still require a device check. Review artifacts are temporary under `/tmp/foryou/`.
