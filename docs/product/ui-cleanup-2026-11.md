# UI cleanup, November 2026

What was removed, merged or rewritten in plain words so that no screen shows a useless or incomprehensible button,
text, shortcut, identifier or badge. Built from the commit history: the first pass is the 31 `fix(ui)` /
`refactor(ui)` commits of 2026-11-14 (07:43 to 08:56 UTC, live since the 09:45 restart); the second pass is branch
`resume/terminal-ui`; the third pass is branch `resume2/ui-audit`. Each line reads before → after, with its commit.

The rules these follow are in [session-contract.md](session-contract.md) and CONTRIBUTING.md: plain short words, no
paths, commands, ids or jargon on screen, no permanent help text.

## First pass (2026-11-14)

### Session page

- Raw « >_ terminal screen » band (pane text polled every 1.5 s, key names for screen readers, a Settings hook to open
  it for Codex menus) → removed; settings are reached from the header chip. [cc584be]
- Header: raw machine id → removed; « {n} in background » → removed (the helpers band already says it); « settings »
  link → merged into the model chip; « browser » → « see the app »; « {n} queued » → removed; unknown project showing
  its id → « sessions ». [95d39ad]
- Read-only placeholder → says why; a source-access issue no longer repeated as the placeholder. [95d39ad]
- Stop band: « x » glyph → removed; raw reasons → plain reasons; the tool's raw error → folded under « details ».
  [95d39ad]
- Helpers band: « >_ » glyph on command rows → removed; full paths (« reads · ~/projects/x/src/a.ts ») → file name only
  (a URL shows its host); « subagents · 2 active · 3 done » → « helpers · 2 working » / « helpers · all done »;
  workflow « name · 2/3 » → « deep review · working / done ». [49a5987, 29707c3]
- Settings panel: « /compact » → « tidy up the conversation »; « /clear » + « confirm /clear » → « start over » with
  « erase this conversation » / « keep it »; fast mode « toggle · set from here » → on / off chips; « unavailable » →
  « send a message to resume »; unused « approvals » key → removed. [7244bec]
- Folded agent message « coordination · codex · 01a1c624 » → « message from codex · <session title> » (left out when
  the title is unknown). [3ea71ec]
- Render progress: « Last observation at 21:04:12 », « Last progress at … », « The render continues independently… »
  → one line, « updated 2 min ago »; pause reasons about workers and provider capacity → what happened plus « ask in
  the chat ». [d6bb688]
- Codex relay in a session: « Codex takeover plan » → « ask Codex for a plan »; « relay of » → « taking over »;
  « auto task » → « automation ». [d78c497]
- Dead catalog keys removed (pages: notFound, resume, machines, online, sessions). [a3d1b88]

### weevboss focused conversation

- « browser » option (opened an empty preview) → removed for weevboss; kept for sessions as « see the app » /
  « close the app ». [9ee5ec3]
- Source-access issue repeated as the composer placeholder → removed. [9ee5ec3]
- Empty-thread greeting: second sentence naming the internal « bands » vocabulary → removed (client and server copies).
  [13bbe70, efa3b65]
- Dead keys removed (conversations, backToFeed, working, yourTurn, background). [5e16c85]

### Message delivery (outbox)

- « awaiting confirmation », « saved, waiting to be forwarded », « forwarding » → « sending… »; « receipt uncertain —
  no automatic resend » → « not sure it arrived »; « forwarding failed » → « not sent »; « tracking temporarily
  unavailable » line → removed. [8147844]
- Upload errors « failed (502) » → « that didn't go through, try again ». [13bbe70]

### Server messages shown in the app

- « a terminal weevils doesn't drive » → « opened elsewhere, outside weevils »; « message submitted to the terminal »
  → « sent, not confirmed yet »; « this session's screen » → removed; « Esc here would close the session: answer 1 or
  Enter » → « that would close the session: pick an answer instead »; « terminal sessions idle » → « sessions started
  outside weevils »; « your access code is terminal access » → « a full key to this machine ». [efa3b65]
- Sign-in link warning « localhost » → « only works on this machine ». [fbacb1c]

### For you feed

- Permanent overlays « view full image ↗ » / « open video ↗ » and the caption « Open full image » → removed (the media
  itself is the button; its accessible name keeps the words). [d66674f]
- Raw file name in the media viewer header → removed. [d66674f]
- « Original wording » disclosure repeating the same title and text → kept only for a real rewrite; rewrite and
  translation share « original »; translation status → « not translated yet » / « couldn't translate ». [d66674f]
- « Receipt unconfirmed; nothing has been resent. » / « View existing work » → « Asked. », « Sending… », « Not sure it
  arrived. », « Waiting its turn. », « Working on it. », « Done. », « Open ». [d66674f]
- « accepted » → « sent »; « cut off » → « stopped ». [d66674f]
- « Read the instructions to send » → « what will be sent »; permanent hint « Choose an option before sending. » →
  removed (the send button stays disabled until a choice is made); unused previous/next image keys → removed.
  [d66674f]
- Image rails: « Previous view » / « View 2 of 3 » / « Next view » as visible text → ‹ 2 / 3 › (full words kept as
  accessible names). [bdb29da]
- Tips: « tip » / « for you » kind label on every card → removed (kept as the accessible name); wording aligned
  (« automations band », « GitHub projects », « ultracode » introduced). [57db03a]

### Automations

- A run's « its session » with the >_ glyph → « open the conversation » with the conversation icon; test proposals'
  terminal icon → removed. [5090ee3]
- Raw run log on the run page → behind « full log »; changed file paths → behind « N files changed ». [5090ee3]
- Token counts (« cost 412K », « 12K tokens ») → removed from facts, run lines and the run page. [5090ee3]
- « automated » (untranslated in French) → « automations »; « outputs » → « results »; « after the agents » → « after
  your sessions finish »; « #3 » → « 3rd in line »; unknown length « 0 » → « not known yet ». [5090ee3]
- A job's live line showing the raw last log line → removed; page head with an internal id → project or folder name.
  [5090ee3]
- « ⋯ » delete icon on every drawer band → a plain « delete » button on the automation's page only. [5090ee3]

### Codex relay page

- « propose a plan » / « automatic » plus a permanent help line → « ask me first » / « take over alone » / « never »,
  help line removed; « switch ahead at » → « hand over when Claude reaches ». [d78c497]

### App preview and software page

- Address chips listing localhost / 127.0.0.1 first → local addresses skipped, host name only, one chip per host;
  placeholder « https:// » → « app address »; close → « close the app ». [a9821f0]
- Header « vps · :4173 · running · … » → « running · <blurb> »; « No visual interface » → « Runs in the background »;
  « Visual preview unavailable » → « No preview yet »; fake « $ git log » typewriter (its lines, CSS, key and poll) →
  removed. [10c5f40]

### Conversations

- « continue with » choice: « > » prompt marker and lowercase tool ids → « Claude » / « Codex » with a tick; « continue
  with Claude (new session) » → « continue with Claude ». [8640470]
- Page titles with stray glyphs (« " conversations ») → « conversations ». [8640470]
- Import moved onto the conversations page; two-line button → « pick your ChatGPT or Claude.ai export » (no file
  extensions); raw server error on a failed filing → removed. [8640470]

### Settings and project bands

- Band headed « machines » with one line per machine (all opening the same page) → headed « settings », one machines
  line (« 1 of 2 online »). [7fef4b2]
- Machine ids next to repos → nothing with one machine, the machine name with several. [7fef4b2]
- Job line showing the raw last log line → « running » / « last run 2h ago » / « failed 2h ago ». [7fef4b2]
- « new session elsewhere » → « new session »; « conversations » + « import conversations » lines → one conversations
  line with its count. [7fef4b2]
- Notifications: the greyed line now says why; « on » no longer said twice. [7fef4b2]
- « repos » → « code folders »; « auto » → « automations ». [7fef4b2]
- Language line: « default » / « chosen here » meta → removed. [5631011]
- « Lost features » (untranslated in French) with « experimental features · Think disabled » → « experiments » /
  « expériences » with « Think · disabled »; repeated kicker → removed. [71c2923]
- GitHub list: « repos », « plug in github », « create repo » → « GitHub », « N projects », « connect GitHub »,
  « create on GitHub ». [71c2923]

### Files and new session

- « / repos » title + « {n} repos » + machine id on each line → « Folders » (machine name only with several). [65d1c0d]
- Folder « / src » under « repo/parent/dirs » with « vps · 602 files » → its name under its parent's name, « 602
  files ». [65d1c0d]
- « + 100 more files not shown » (dead end) → « show 100 more » loads the next slice. [65d1c0d]
- File size → removed; « only the beginning is shown » when cut. [65d1c0d]
- « machine:/path » kickers and a bare « ~ » → folder names, « home folder »; raw HTTP / ENOENT errors → plain
  sentences. [23ecc80]
- New session page → « New session », « who works on it » with « Claude » / « Codex », « project » instead of « repo »,
  no machine ids. [65d1c0d]

### Machine page

- ssh commands to copy, reverse DNS, Unix load average, swap, CPU arch and virtualisation, terminal glyph on processes
  → removed; plain OS name, « weevboss runs here », CPU as a percentage. [23ecc80]
- Servers named by port and absolute path → named by their project; one « add a machine » line. [23ecc80]

### Subscription

- « claude 40% week 5 h: 12% » or a lone « ! » → « Claude 40% this week · Codex 3% »; raw machine id and Codex
  terminal glyph in session rows → removed. [23ecc80]

### Think

- « Context to share » disclosure with the board's raw JSON → removed; privacy paragraph → « Sending shares this view
  with the session you pick. »; « Accepted for delivery » → « Sent »; pending request → « Send it again first »; French
  uses « tu » and « tableau » instead of « canvas ». [f5b7ab2]

### Memory

- « # » title glyph → removed; « x forget » / « really? » → « forget » / « sure? »; « by hand » → « added by you »;
  « nothing » → « no memories yet ». [57db03a]

### Setup, first steps, voice

- « paste OPENAI_API_KEY » and raw variable-name questions → « paste your OpenAI key » / « your GitHub token »;
  « (empty: root) », « my key » → questions that say what an empty field means. [d7472a9]
- Siri chip « copy my siri address » / bare « siri » → « add to Siri ». [d7472a9, 79d5122]
- Recording errors about « chunks », « retained original », « audio storage », with « vous » → short plain sentences
  with « tu ». [79d5122]
- Install step « from the terminal, 5 min ago » → « installed 5 min ago »; « a vps », « your pc (wsl) » → « a server
  that never sleeps », « your server », « your pc ». [4d28158]

## Second pass (branch resume/terminal-ui)

### Session page and focused thread

- Question card header « ! claude is asking » → « Claude is asking » (no glyph, the tool's real name).
- Stopped band, signed out: only « resume » (which fails again while signed out) → « sign in again » first (runs the
  in-app login in weevboss's thread: a link, then a code to paste), « resume » for afterwards, « dismiss ». The
  three buttons wrap onto a second line on a narrow phone.
- Stopped band in the focused thread: missing (a stopped session looked idle there) → the same band as on the session
  page.
- A waiting session with nothing to tap (a hook notification, no input box on screen): text only → « Continue » /
  « Go back ».

### Subscription

- « 40% · 412 k tokens » on each model, project and session line → « 40% »; the tool id in front of each model line
  (« claude · ») → removed (the model name already says it).

### Setup (weevboss thread)

- « RUNPOD_API_KEY : •••• » (the user's line) → « my RunPod key: •••• ».
- « RUNPOD_API_KEY saved in ~/.config/weevils/env (never shown). The agent that asked for it can read it there. » →
  « RunPod key saved on this machine (never shown). The agent that asked for it can use it. »

### Requests page

- Page title « ! requests » → « requests ».
- A request sent to a session with no recorded name: « sent to 0a1b2c3d » (raw session id) → « sent to a session ».

### First steps, hints, For you milestones

- First-steps swipe item « your repos » → « your GitHub projects » (the page it opens is titled « GitHub »); « 2 repos »
  → « 2 code folders » (it counts git folders on the machine); « it exists, with its repo » → « it exists, with its
  GitHub project ».
- First-steps item « auto » → « automations »; hint « the auto band » → « the automations band » (as in the tips).
- Hint « all your github repos… » → « all your GitHub projects… ».
- Milestone « First auto task wrapped up on its own… » → « First automation finished on its own… »; stat label « Auto
  queue » → « Automations ».

### Code

- Unused « >_ » → terminal icon mapping → removed (nothing passed it any more).

## Third pass (branch resume2/ui-audit, r162)

A fresh read of every screen on the maintainer's live instance (phone viewport, read-only) and of every catalog.

### Session page

- The line under the title repeated, word for word, what the header's live line already said (« QA pass on ad videos »
  twice on the same screen) → said once in the header; the full sentence stays under the title only when the header
  had to shorten it (more than six words, or a narrow screen cutting the pill with « … »).
- « claude · working for 3 min » (the tool's lowercase id in front of the status; the model chip already says which
  one) → « working for 3 min ».
- Composer placeholder « write to claude » / « resume with codex » → « write to Claude » / « resume with Codex ».
- Archived sessions: « claude · stopped » → « Claude · stopped ».

### weevboss thread, notifications, For you

- Why a session was cut off: « process stopped » / « processus arrêté », « stopped with uncommitted work » / « arrêtée
  avec du travail non commité », « login expired », « API error » → « unexpected stop » / « arrêt inattendu »,
  « changes not saved yet » / « changements pas encore enregistrés », « signed out » / « déconnectée », « service
  error » / « erreur du service » (the line in weevboss's thread, the notification and the For you card).
- For you: « The auto task “X” crashed / is wrapped up », « I started the auto task “X” » (« La tâche auto « X » … »)
  → « The automation “X” … » (« L’automatisation « X » … »); the figures the curator writes from, « 3 auto tasks
  done » → « 3 automations done ».
- For you pulse « 3 on auto » / « 3 en auto » → « 3 automations in progress » / « 3 automatisations en cours ».
- The cost automation's description: « … subagent, auto task and internal call … » → « … subagent, automation and
  internal call … ».

### Subscription

- Codex plan shown as its raw id (« Codex · prolite ») → its product name (« Codex · Pro Lite »; « plus » → « Plus »,
  any other id capitalised); Claude's « Max 20x » unchanged.

## Kept on purpose

- The live token meter's accessible name (« N tokens per minute, all sessions »): it is the only thing that explains
  the number shown top right, and it is never visible text.
- The « ! » in front of error lines: one consistent alert mark across the app, with `role="alert"`.
- The request id (« r12 ») in a request's folded detail: it is how Scarville and weevboss refer to requests.

## Still open

- Nothing from the first two passes. A model chip for a model weevils doesn't list yet still shows its raw id in the
  model picker (rare: only right after a new model ships); left as is because the picker and the settings module
  import each other.
