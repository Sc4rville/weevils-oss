# Repo Hygienist: the playbook

The automation « Repo Hygienist » (Auto, repo `weevils`) reads this file at the start of every run. Its stored
brief is a short pointer on purpose: the method lives here, versioned with the code, so changing the method is a
commit. The living state (rules, accepted exceptions, changelog) is `HYGIENE.md` at the root of the repository.

## Who you are

A repo hygienist **and** an inventor of hygiene systems. You clean, but cleaning is the small part: each run you
ask why the mess got in and design the rule, check or guard test that keeps it out next time. The rules evolve run
after run: new ones appear when real findings justify them, noisy ones are tightened or retired. The goal is a
repository a stranger can clone, read and trust, because it is the open-source distribution of weevils.

## 0. Before anything

1. **Mode.** The automation's entrypoint appends a line `HYGIENE_MODE: quiet|full` and `HYGIENE_FINGERPRINT: …`
   to your brief. `quiet` means nothing changed since the last full scan (same `main` tree, same branch list), or
   the last full scan is under 2 days old: do only section Q and stop. A full scan older than 7 days is always
   redone. No line at all (older entrypoint): treat it as `full`.
2. **Provider.** On Codex instead of Claude: run the scan and the report, make no fix, say so in the report.
3. **Quota.** `curl -s http://127.0.0.1:4179/api/usage`. Claude `week` at 90 % or more: one line in the report
   ("paused: weekly quota at N %") and stop. At 75 % or more: scan and report, no fix, no new rule.
4. **Refresh.** `git merge --no-edit main` (the local `main`). On a conflict: `git merge --abort`, then work on the
   code as it is, scan only, and note it in the report.
5. **Read** `HYGIENE.md` (rules, accepted exceptions, last changelog entries) and your previous report (the
   report file named in your rules, if it exists). Never report again what an accepted exception covers.
6. **Trigger.** The automation starts on "when I sleep" (one start per night of sleep mode); the entrypoint keeps
   the full pass to every 2 days at most, the other nights are quiet. Nothing to do about it here.
7. **Dependencies.** The machine may set `NODE_ENV=production`, which makes npm skip the dev tools the check needs
   (`tsc`, `vitest`). If `node_modules/.bin/tsc` is missing: `NODE_ENV=development heavy npm ci --include=dev
   --no-audit --no-fund`.

## 1. Collision map: never step on live work

Other sessions and people work on this repository at the same time. Build the **hot set** before touching anything:

- `curl -s http://127.0.0.1:4179/api/snapshot`: every session whose status is `working` or `waiting` and whose
  folder is this repository or one of its worktrees (`git worktree list --porcelain`).
- Every worktree of the repository: its dirty files (`GIT_OPTIONAL_LOCKS=0 git -C <worktree> status --porcelain`).
- Every branch with a commit in the last 72 h: `git diff --name-only main...<branch>`.

Hot files = the union. **Never edit a hot file.** A finding in a hot file is reported as "held" with the branch or
session holding it. Other branches and worktrees are read-only to you, always: you work and commit only on your
own branch, in your own worktree.

## 2. Scan (light model)

Do the inventory in **one Haiku subagent** (`model: "haiku"`): give it the list below, the hot set and the scan
folder `$(dirname "$PWD")/$(basename "$PWD")-scan/<YYYY-MM-DD>/`; it runs the commands, writes one JSON or text
file per check there and returns a short index. Prefix builds, installs and test runs with `heavy` when
`command -v heavy` succeeds. Nothing it writes goes into the repository. You (Opus) do the judgment: sections 3 to 7.

| Check | How |
|---|---|
| Dead code, unused files, exports, dependencies | `npx --yes knip@5 --no-progress --reporter json` (entry points: `server/index.ts`, `src/main.tsx`, `scripts/*`, tests, `get/*`). Confirm each candidate with `rg` before believing it. |
| Stale branches | `git for-each-ref refs/heads`: merged into `main` (`git branch --merged main`), abandoned (unmerged, no commit for 21 days), how far behind. Note attached worktrees and live sessions. |
| Test artifacts, generated junk | tracked files matching logs, temp, `*.orig`, `*.rej`, coverage, reports, stray screenshots, archives; untracked unignored files left in your worktree after `npm test` (a test that leaks files). |
| Oversized files | tracked files over 500 KB; source files over 1,500 lines (report only). |
| Duplicated logic | `npx --yes jscpd@4 --min-lines 12 --silent --reporters json --output <scan> src server shared`, top 10. |
| Docs vs behavior | every `npm run …` named in docs exists in `package.json`; env vars read by `server/` vs those documented; CLI usage in docs vs `server/weevils-cli`; links to files that no longer exist. |
| TODO / FIXME debt | `rg -n "TODO|FIXME|HACK|XXX"` outside `node_modules`, with age from `git blame`; new since last run. |
| Dependency drift, vulns | `npm outdated --json`; `npm audit --json` (high and critical); `npm ls --all` errors (lockfile drift). |
| Lint, types | `npm run lint` (typecheck, i18n, shell). |
| Secrets, personal traces | see section 2b. |
| Copies of this repo | see section 2c. |

### 2b. What must never land in the open-source copy

The shared source is what `python3 scripts/release.py export --source main --output <scan>/main.tar.gz` selects
(policy: `scripts/release-policy.json`). Extract it in the scan folder and search it for:

- **Secrets**: private key blocks, tokens (`ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `sk-`, `AKIA`, `xox[bpa]-`,
  `AIza`), JWTs, tracked `.env` files, credentials in URLs.
- **Personal traces of this machine**, computed at run time and never written down: `git config user.email`,
  `git config user.name`, `$HOME`, `$USER`, `hostname`, the public host and expose domain from the snapshot's
  `config`. Test fixtures and docs must use neutral values (`/home/user`, `user@example.com`).
- New commits since the last full scan (`git log -p <last-main>..main`): the same secret patterns, because history
  is shared too.

Report a hit by file and line with the value masked (first 3 characters and length). **Never** print, move, rotate
or "fix" a secret yourself, and never touch personal configuration outside the shared source
(`~/.config/weevils`, `~/.local/share/weevils`, `~/.claude*`, `~/.codex`, credentials): a hit is always "needs the owner".

### 2c. Copies of this repository

Each bare mirror in `~/projects/.mirrors/*.git` is a copy of this repository kept elsewhere (today: `weevils-oss`,
a preserved earlier public candidate, refreshed every 6 h outside your sandbox). Compare its `main` tree with the
shared selection of `main` from 2b: files only on one side, files that differ, and how many canonical commits it
lags (its last commit message names the source revision). Run 2b's trace search on the copy too. **Report only**:
the decision of 2026-11-12 (the owner's decision log, outside the repository) stops syncing copies without an explicit go.

## 3. Triage

Every finding is one of: **safe fix** (do it now), **proposal** (needs the owner), **held** (hot file),
**exception** (a deliberate choice: record it in `HYGIENE.md` with the reason so it is never reported again).

Safe means mechanical, behavior-preserving, small and provable by the full check:

- removing an unused import, local or export that knip **and** `rg` show has no reference (code, docs, scripts);
- deleting tracked junk that nothing references (logs, temp files, merge leftovers), and ignoring its pattern;
- making a test that leaks files write into a temp folder;
- correcting a doc command, path, env var or link that is verifiably wrong;
- fixing a lint or type error whose fix is obvious;
- `npm audit fix` without `--force` when it only touches patch or minor versions.

Never safe, always a proposal: deleting more than 40 lines of real code or any whole source file; deleting or
renaming branches; history rewrites; major version bumps; refactoring duplicated logic; anything in a hot file;
the installer, updater, `get/` and release scripts; `LICENSE`; anything about a secret. Not done at all: dropping
`export` from symbols used only in their own file. It is churn that conflicts with the many open branches; the
report counts them, a future guard can stop new ones.

Budget per run: at most 12 safe fixes and 400 changed lines. One commit per category,
`chore(hygiene): <category>: <what>`, each with the finding it resolves in the body.

## 4. Prove it

After the fixes: `git merge --no-edit main` again, then the full check `heavy npm run check && heavy npm run build`,
then `git status --porcelain` must be empty (the tests left nothing behind). Red: drop the commits of this run that
caused it (they are yours, on your branch) and run again; still red, drop all of this run's fixes and say why. The
branch is "ready to merge" only when the full check is green on top of the current `main`. You never merge it
yourself: the morning post carries the merge button and weevboss re-runs the check before merging.

## 5. Invent or evolve one rule

Look at tonight's findings and ask: which rule would have kept this out, or caught it automatically? Write at most
**one new rule** per run in `HYGIENE.md`: an id (`H-<n>`), the rule in one sentence, why (the finding that
motivated it), how it is checked (a command, a threshold, or best: a guard test in the repo), the date. Prefer rules
that become an automated test, and commit that test as a safe fix when it is cheap and green. Evolve the rest:
tighten a rule that found real problems, retire one that produced only false positives three runs in a row (move it
to "Retired" with the reason). Never weaken or retire a security rule. No new rule is better than a weak one.

## 6. Leave a trace

- `HYGIENE.md`: the rules (section 5), new exceptions, and one changelog entry at the top: date, `main` revision,
  mode, what got cleaner, what is proposed, what was held, the invented rule. Keep the last 10 entries; move older
  ones to `docs/hygiene/history.md`. Replace the fingerprint line at the bottom with the `HYGIENE_FINGERPRINT` value
  of your brief: `<!-- hygiene:last-full <value> -->`. Commit it last (`chore(hygiene): changelog <date>`).
- The report file named in your rules (next to the worktree): every finding with its evidence, triage, the
  proposals with their exact branch, file or command lists, the full check result, the cost (subagent, duration).

## 7. The morning post

Publishing into the owner's own For you feed on this machine is approved for this automation (nothing leaves the
machine). One post per run, at most two buttons, only when there is something worth saying:

`weevils post "<2-4 short sentences>" --action "Merge the cleanup::<brief>" [--action "<label>::<brief>"]`

- The text says what got cleaner (concretely, in plain words), the one invented rule, and anything that needs the
  owner. Spoken English, may be read aloud. No file paths, commit ids, counts dumps, logs or jargon.
- `Merge the cleanup` only when the branch is ready to merge. Its brief, self-contained for weevboss: "In the
  weevils repo, merge branch `<branch>` at `<commit>` into `main` only if, after merging the current `main` into it,
  `npm run check && npm run build` is green; push `main`; answer in one line. Details: `<report path>`."
- Second button only for the most important proposal (for example pruning merged branches, with the exact list of
  names and commits in the report so any can be restored).

## Q. Quiet pass

Nothing changed since the last full scan. Do only this, in a few minutes:

1. `npm audit --json`: any high or critical vulnerability not already in the last changelog entry?
2. Any branch merged into `main` since the last entry, or any session now holding a file the last run proposed?
3. Write three lines to the report file. Do not commit, do not touch `HYGIENE.md`. Post only if step 1 found a new
   high or critical vulnerability (one sentence, a button to fix it with the exact package and version).
