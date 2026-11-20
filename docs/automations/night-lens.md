# Night lens: the nightly playbook

The automation « Night lens » (Auto, repo `weevils`) reads this file at the start of every run. Its stored brief
is short on purpose: the method lives here, versioned with the code, so a change to the method is a commit.

## Purpose

Every night, take real time to stand in someone else's shoes (an entrepreneur, a builder, a plain human user) and
look at weevils as they would: the discussion flows (weevboss, project session threads), the features, the options,
the For you page. The question is always the same: how do we make it richer, more intuitive, simpler, more
readable, **without restricting the user in any way**. Nothing a user can do today may become impossible or harder
to reach because of a proposal. The second goal is For you itself: it should carry content worth reading, close to
philosophical, never filler.

## 0. Before anything

1. You must be Claude. If this run is on Codex, write one line in the report saying so and stop.
2. Quota: `curl -s http://127.0.0.1:4179/api/usage`. If the Claude `week` window is at 90 % or more, write one
   line in the report ("paused: weekly quota at N %") and stop. Above 75 %, do a shorter walk (one journey, no fix).
3. Refresh your branch: `git merge --no-edit main` (the local `main`). On a conflict, `git merge --abort` and carry on
   with the code as it is, noting the revision in the report.
4. Sleep trigger: Night lens already runs « when I sleep », with its 01:00–05:00 window as the fallback on a night
   sleep mode never came. Never offer to switch it.
5. Read `../reports/night-lens/ledger.md` (beside the worktree, kept between runs, never committed) (create it on the first run): past personas, journeys,
   proposals and pieces, with what became of them. Also read the latest report of the UX consistency audit
   (`git log auto/find-ux-inconsistencies-156a --oneline -- reports/ux-consistency`, then `git show` its newest
   report) so you never propose again what it already found.

## 1. Pick a persona and one concrete journey

Rotate, never the same persona two nights in a row:

- **Entrepreneur**: runs a business with agents, judges value per minute, wants to know "is it moving, what does it
  cost me, what do I decide now".
- **Builder**: a developer driving several sessions, wants control, precision, raw detail on demand, speed.
- **Plain human**: not technical, curious, easily lost by jargon, needs to feel safe and to understand what happened.

A journey is a real task with a start and an end, from the phone: "catch up on the night", "find out why a session
stopped and resume it", "start a small app from scratch", "understand what an automation did", "decide what to do
with three For you cards", "change a setting I heard about"… Pick one the ledger has not covered lately.

## 2. Walk the real live app

The live app answers on `http://127.0.0.1:4179` from this machine. Drive it in headless Chromium with
playwright-core (install it in your worktree with `npm i --no-save playwright-core` if missing; the browsers are in
`~/.cache/ms-playwright`). Mobile viewport: 390×844, touch, device scale 2, English.

**Read-only, enforced, not promised:** before the first navigation, route every request to `/api/**` whose method is
not `GET` (and every `/api/**/send`, `/api/**/accept`, `/api/**/refuse`, `/api/**/run`) to `route.abort()`. Never
type into a real session, never tap accept, refuse, run, delete or resume for real. The user's sessions, cards and
automations must be exactly as they were after your walk. To see what a tap would show, read the code
(`src/ui/…`) or render the next state in a mockup.

Walk the journey screen by screen, the way the persona would, and screenshot each step into
`../reports/night-lens/<YYYY-MM-DD>/`. Note, with the screenshot that proves it: friction, clutter, jargon, missing
affordances, dead ends, things that read badly on a phone, and also what works well (so it is never "fixed").
Use real session threads and the real For you feed (`GET /api/foryou`, `GET /api/snapshot`, `GET /api/sessions/<id>`)
as material. A point without a screenshot or an observed flow behind it is not a point.

Cost: do the walk in **one Sonnet subagent** (`model: "sonnet"`), given the persona, the journey, the read-only rule
and the screenshot folder; it returns its notes and file names. Never more than one subagent at a time, never Fable,
no workflows. You (Opus) do only the synthesis below.

## 3. Synthesis: at most 3 proposals

Keep the three strongest points, fewer if fewer are strong. Each proposal has:

- **Before / after**: the real screenshot, and an "after" image. For a small change, apply it on this branch, build
  and screenshot the result. For a bigger one, a mockup: a static HTML copy of the screen with the change, rendered
  to PNG in the same viewport. Put both side by side in one PNG (`<n>-before-after.png`).
- **Why**, in the persona's words: what they were trying to do and where it hurt.
- **No capability removed**: say explicitly what stays reachable and how (one line). If a proposal hides, merges or
  moves something, it says where it went and how many taps it now takes. A proposal that removes an option is dropped.

Small, safe readability fixes (wording, contrast, spacing, a label) may be committed on this branch with a test
that pins them (`npm test` must stay green; respect the house rules: every string in both catalogs fr + en, four
themes, flat bands, sharp corners). Anything bigger stays a proposal.

Stop early, and say so in the report, when the walk found nothing that is not already in the ledger or the UX
consistency reports. A night with nothing new costs little and publishes no proposal; the piece (step 4) is still
written.

## 4. One thoughtful piece for For you

Exactly one per night, every night, even when the walk stopped early or found nothing (only the Codex and the 90 %
quota stops of step 0 skip it). This is the part the user reads with their coffee: take real time over it. It must
be worth reading on its own, close to philosophical: an idea that changes how one sees the work, not a status. It is: an insight about how the user's agents actually worked
(read the real Claude Code transcripts in `~/.claude/projects` and the session threads: patterns of rework, where
time went, what kind of brief produced clean work, how a decision travelled), a pattern across projects, or a
well-argued idea about the product. Grounded in something real and named, with the evidence in one line.

Shape: a title that is a claim, not a topic (« The brief that asked fewer questions got better work », not
« Thoughts on briefs »). Then 150 to 300 words of plain prose: the observation, the evidence in one line (what,
where, how many), what it means beyond tonight, and one quiet question or consequence to end on. No list, no
heading, no emoji, no file path, no session id. Read it once more as a stranger would: cut every sentence that only
fills. Never the same subject as the last three pieces in the ledger.

Never: a restatement of the user's own ideas, memory or brief presented as weevils' insight; filler or
motivational talk; test output, logs, raw commits or token counts as the content itself.

Write it to `.night-lens/piece.md` in this worktree (git-ignored): the title on the first line, a blank line, then
the text. Never post the piece yourself: the automation's adapter publishes that file to For you once, and keeps it
for the next run if the post failed. Copy it into the report too.

## 5. Publish

Publishing into the user's own For you feed on this machine is the one posting the user approved for this
automation (no mail, no PR, no social network; you never push: weevils pushes this branch to GitHub itself after the
run, so the report never stays on this machine only). Use the CLI, which talks to the local server:

- Each proposal: `weevils show ../reports/night-lens/<date>/<n>-before-after.png "<one-line caption>"`, then
  `weevils post "<2–4 short sentences: what the persona hit, what we change, what stays>" --action "Build it::<a
  self-contained brief for weevboss: the change, the files, the no-capability-removed guarantee, the branch if a
  fix is already there>"`.
- The piece: not here, it is the file of step 4.
- A readability fix already on the branch: its proposal's button is `Merge the fix::<brief naming the branch, the
  commit and the test>`.

Short, plain, spoken English: it may be read aloud. No jargon, no file paths in the text (they go in the button's
brief), no emoji. Buttons only for real next steps.

## 6. Leave a trace

- `../reports/night-lens/<date>.md`: persona, journey, the screens walked, every observation with its screenshot,
  the proposals (with their guarantee), the piece, what was published, and the cost (subagent and total time).
- Append one entry to `../reports/night-lens/ledger.md`: date, persona, journey, proposal titles, piece title.
- Commit both and the screenshots on this branch (`docs(night-lens): <date> <persona> · <journey>`).
- The report next to the worktree (the path given in your rules) gets the same summary, short.
