# Official logo rollout

This prepared OSS branch reuses the approved logo from source commits `6d03b76`
and `1b95bd2`. It does not generate or redraw the mark. The original and transparent
PNG retain their source hashes; attribution and processing provenance are recorded
in `src/assets/weevboss-*.source.json`. Private message identifiers are omitted.

The shared UI component, favicon, README and isolated demonstration use the new
mark. The demonstration loads only the same-origin static PNG; its content policy
continues to block provider requests (`connect-src none`). Theme filters affect only the logo. Recording retains
its distinct colour. Docker source packages include these files through the
existing source-copy build step; no running instance has been updated.

## Remaining work

- `public/icon-{180,192,512}.png` and `scripts/make-icons.mjs` still use the earlier
  colour bands. The branding owner is preparing the official PWA exports.
- `docs/screenshot.png`, `docs/first-run.png` and `docs/first-run.gif` are historical
  demonstration captures with the earlier logo. They have not been retouched or
  replaced with purported new screenshots.
- Desktop/mobile browser inspection and new neutral captures remain required.
  Automated DOM and colour checks do not constitute visual approval.

Do not describe the branding rollout as complete until these remaining supports
have been refreshed. Existing licenses and third-party attribution notices remain
unchanged. This work does not publish the repository or deploy any instance.
