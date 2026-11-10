# Provisional decisions of the prototype

Made to move forward, all reversible. The validated requests are in [`vision.md`](vision.md).

- **Stack**: Vite + React + Motion (springs, drag), as an installable web app (PWA). Local demo data, saved in the
  browser (prototype only: the app now reads everything from weevilsd).
- **Character icons**: `/` files, `@` machine, `!` your turn, `"` conversations, `+` new session. Session states:
  `*` working (slowly spinning), `!` your turn (inverted black line), `_` available, `✓` done.
- **Accordion**: touching a name opens the band (48 px title, conversations, repo, machine, 24/7); the others become
  strips (22 px name + summary). Touching again closes it.
- **Sub-bands**: same hue, shifted lightness (saturation kept) for inner areas and the user's messages.
- **Pages**: session, conversation, files, machine and new session open full screen in the project's color; back with
  `<`, a swipe to the right, Escape or the back button.
- **Main agent**: routing by simple rules (project name + claude/codex); otherwise it asks where to send. The
  "to sort" list lives in its band. (Since replaced by weevboss, a real Claude session.)
- **Invented category**: `ideas`, with no repo, to show what weevils does with an exchange outside any repo.
- **Palette**: light = violet `#B39BFF`, blue `#6FA4FF`, coral `#FF7F67`, pink `#FF8AD6`, mint `#5FE3A1`, amber
  `#FFC64C`; dark = deep versions from the kit + `#861A73` and `#0B6B4A`.
- **Demo**: last band (theme, simulated terminal session, reset); it filled the screen down to the 24/7 rail so no
  area stayed without color. (Removed once real data arrived.)
