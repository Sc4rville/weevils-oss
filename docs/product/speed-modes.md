# Speed modes (draft, not implemented)

Phase 1, shipped: measurement only (`server/spend.ts`, the "pace" lines on the subscription page).

- Every Claude Code answer in `~/.claude/projects/**/*.jsonl` (subagents and workflow agents included) is counted once
  (message id + request id) and priced at API list prices, 5 min and 1 h cache writes apart, fast mode doubled. Same
  method as ccusage (MIT); its daily totals match ours to the cent on this machine.
- Codex: token counts only (its own quota, no dollar figure).
- The link to the real subscription: dollars of the week up to a quota reading divided by its percent, or, once the
  percent has moved 5 points since the first logged reading of the week, the marginal rate since then.
- Each new quota reading is logged with the estimate in `spend-calibration.jsonl` (data dir);
  `node scripts/spend-report.ts` prints the error margin. `scripts/spend-log.ts` does the same logging without the
  server route (reads the quota the running weevils saved).

Phase 2 draft, names not final: five levels, each a budget share of the 5 h window.

| Level | Budget | Behaviour |
|---|---|---|
| Pause | 0 | nothing new starts |
| Idle | small | below Cruise: unfinished work is not resumed on its own |
| Cruise | medium | default |
| Turbo | high | weevils dispatches and launches automations on its own |
| Max | all | same as Turbo, no cap |
