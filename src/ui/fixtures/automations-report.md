I've fixed the automation sandbox and added the two guarantees you asked for, and it's all live on main (`c857bff`, pushed, weevilsd restarted at 16:17). The full test suite passes on the merged main (2267 passed, 1 skipped). Night lens `04a7022` is merged too: its tests passed (15/15) and typecheck is clean.

## What changed
- **Weevils commands in automations:** they were blocked three ways: a deny rule on every `weevils` command, the CLI pointed at a dead port, and the CLI itself. All three now let the allowed commands through.
- **Worktrees start from current main:** a new automation branches from the repo's main (fetched first). An existing worktree is fast-forwarded or merged up to main before each run, unless it has uncommitted changes. The ad factory worktree (still on `d46866d`) and Night lens's are both clean, so they catch up on their next run.
- **Supervisor, day and night, sleep mode or not:** a run that fails, sits still for 45 min, or says a permission or the sandbox stopped it is restarted 15 min later. Restarts go through the normal queue, so machine load, memory and quota holds still apply. Each run gets at most 2 restarts in a row; after that it's marked "still failing". Every decision is logged with its reason.
  - Runs stopped by the user on wake, deleted, or out of quota are never restarted.
  - Refusals of things that stay forbidden (publishing, pushing, paying) don't count as "blocked", so they're not retried.
- **No silent block on questions:** automations can no longer pop a question. If a session still ends up waiting on one for 5 min, the question goes to For you as a card, and the agent is told to carry on with the safest option.
- **Wake-up recap:** it now lists what ran, what was restarted (1st, 2nd time) and why, and what still failed and why. Example headline: "Overnight: 2 results, 3 relaunches, 1 stopped."

## Permission profile, in plain words
- **Allowed:**
  - weevils `sessions`, `read`, `asks`, `projects`, `new`, `send`, `post`, `show`
  - git add and commit on the automation's own branch
  - builds and tests through `heavy`
  - RunPod (its login is now visible inside the sandbox)
  - reading and editing files
- **Push:** after a run that committed something, weevils itself pushes that automation's own `auto/…` branch. Never main, never forced. The agent never holds a GitHub credential.
- **Still denied:**
  - every other weevils subcommand: refused by Claude Code and, separately, by the CLI itself
  - git push by the agent, `gh`, publishing packages or images, sending data out with curl/wget
  - ssh, sudo, crontab, systemctl
  - tmux and the live weevils socket, which is also hidden inside the sandbox
  - deleting outside the automation's folder
  - reading keys, `.env` files and credentials, editing the user's config

## Proof
- **Dry automation run:** a real Claude session (Haiku), inside the real sandbox with the real profile:
  - `weevils sessions` succeeded and listed the 4 live sessions.
  - `weevils memory` was denied.
  - `git push origin main` was denied.
  - Called directly inside the sandbox, `weevils memory` is also refused by the CLI.
- **Tests:**
  - A blocked "when I sleep" automation (the ad factory's exact error text) is restarted within the night and shows in the recap.
  - In daytime with sleep mode off, a blocked automation is restarted.
  - A stalled run is ended and restarted; after 2 failed restarts it is reported as still failing.
  - Branching from main and pushing only the `auto/` branch, tested against real git repos.
- **Screenshot:** posted to For you with `--demonstrated`, `--verified` and two `--limit`s. It comes from a Docker test copy with its own socket. The runs on it were set up by hand, not produced by a real night.

## Decisions and limits for the user
- **`projects` is allowed** though you didn't list it: it's read-only, and `weevils new` needs the project ids.
- **RunPod costs money,** so it conflicts with "never pay". I allowed it as asked; the written rules automations read still say "no paid API". Tell me if they want it narrowed.
- **"Blocked" is detected from the run's own last words.** A run that fails without saying why still counts as failed, and a blocked run reporting it in unusual wording may be missed.
- **In the recap, restarted runs carry the "failed" label,** with "relaunched … after: why" as the detail.
- **Sessions weevboss starts are not supervised.** The supervisor watches automation runs; a session started by weevboss that goes idle with open requests is not restarted (the request list only flags them as stale).
- **Not a hard wall against an agent determined to misuse weevils:** the deny rules and CLI check stop normal use, but a script could still call the local weevils server directly. That was already true before this change.
- **One script change:** `scripts/test-copy.sh` now accepts `WEEVILS_COPY_ORCHESTRATOR=1`, so a test copy can show For you.
