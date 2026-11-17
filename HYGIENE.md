# Repository hygiene

How this repository stays clean enough for a stranger to clone, read and trust. The rules below are maintained by
the « Repo Hygienist » automation (method: `docs/automations/repo-hygienist.md`), which applies them every run,
cleans what is safe, proposes the rest and invents a new rule when its findings justify one. Humans may edit this
file too: a rule changed here applies from the next run.

## Rules

| Id | Rule | Why | Checked by |
|---|---|---|---|
| H-1 | No secret and no personal trace of a machine (owner e-mail, name, home path, hostname, private domain) in the shared source or in new history. Fixtures use `/home/user` and `user@example.com`. | This repository is the open-source distribution. | Section 2b of the method, over `scripts/release.py export`. |
| H-2 | Never edit a file another session or branch is working on (dirty in a worktree, on a branch active in the last 72 h, or in a working session's folder). | Hygiene must never collide with live work. | The hot set, section 1. |
| H-3 | A cleanup reaches `main` only when `npm run check && npm run build` is green on top of the current `main` and the tests leave no file behind. | A green branch on an old base proves nothing. | Section 4. |
| H-4 | Deleting real code (more than 40 lines, or a whole source file), branches or history is always a proposal, never a silent fix. | Recoverable mistakes only. | Triage, section 3. |
| H-5 | Unused exports, files and dependencies are removed only when both knip and a plain text search find no reference, docs and scripts included. | Static analysis misses dynamic and documented entry points. | Section 2, dead code. |
| H-6 | No tracked log, temp file, merge leftover, coverage or test report; generated output stays ignored. | Junk in a public repo reads as neglect. | Section 2, artifacts. |
| H-7 | Tracked files stay under 500 KB unless listed as an exception; source files over 1,500 lines are flagged for splitting. | Clone size and readability. | Section 2, sizes. |
| H-8 | Every command, path, env var and link in the docs exists in the code. | Outdated docs cost newcomers the most. | Section 2, docs vs behavior. |
| H-9 | No known high or critical vulnerability in dependencies stays unreported for more than one run. | Safety of everyone who installs weevils. | `npm audit`, every run including quiet ones. |
| H-10 | Copies of this repository (mirrors in `~/projects/.mirrors`) are compared, never synced, by the automation. | Decision of 2026-11-12: one canonical source. | Section 2c. |
| H-11 | Entry points are declared in `knip.json`; dead-code findings count only when knip runs with it and a plain text search agrees. | Without them knip called the server itself, the service worker, the `get/` scripts and a lazily imported dependency unused (13 false files, 2 false dependencies); with them, zero. | `npx knip` with `knip.json`, section 2. Introduced 2026-11-14. |

## Accepted exceptions

Deliberate choices the automation must not report again. One line each: what, why, who decided, date.

- `harness-interface-kit/` and the other paths excluded in `scripts/release-policy.json` are local or private by
  policy: not part of the shared selection, not scanned as shared source.
- The owner's GitHub handle in `LICENSE`, in repository URLs and in the launchd labels `com.github.<owner>.weevils*`:
  product identity, not a personal trace (renaming the labels would orphan installed services). 2026-11-14.
- The public install entry `get.<domain>` named in `get/`, `server/weevils-update` and their docs: the product's
  own hosted entry point, overridable by environment. 2026-11-14.

## Retired rules

None yet.

## Changelog

Newest first, last 10 runs (older ones in `docs/hygiene/history.md`).

- 2026-11-14 · first run (by hand) · main 17c1bf0 · full
  - Cleaner: 4 exports nothing used are gone; test fixtures no longer carry a real home directory; full check green
    (1,865 tests, build), tests leave no file behind, no secret, no known vulnerability, no real TODO left.
  - Invented: H-11, declared entry points for knip, which turned 13 false "unused files" into zero.
  - Proposed: prune 36 branches already merged and idle (7 bare, 29 with a clean worktree); neutral examples instead
    of a private project's real feed text in `server/foryou-editorial-reviewed.json`; document the 54 env vars read
    by the server but named nowhere in the docs (many are internal); weevils-oss lags main by 35 commits (report only).
  - Held: real home paths in two other test fixtures, both being edited by live work.
- 2026-11-14 · set up · rules H-1 to H-10 written from the owner's brief; no run yet.

<!-- hygiene:last-full main=17c1bf03e401cc850b3c2fa3dafaf3fbe7c7f415 branches=029dc8e5a11b at=2026-11-14T07:20:50.276Z -->
