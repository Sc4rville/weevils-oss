# Official logo rollout

This prepared OSS branch reuses the approved logo from source commits `6d03b76`
and `1b95bd2`, with official icon exports from `384052d` and badge correction `9ccb5f6`, followed by app-icon composition `a6cacec`. It does not generate or redraw the mark. The original and transparent
PNG retain their source hashes; attribution and processing provenance are recorded
in `src/assets/weevboss-*.source.json`. Private message identifiers are omitted.

The shared UI component, favicon, README and isolated demonstration use the new
mark. The demonstration loads only the same-origin static PNG; its content policy
continues to block provider requests (`connect-src none`). Theme filters affect only the logo. Recording retains
its distinct colour. Docker source packages include these files through the
existing source-copy build step; no running instance has been updated.

## Deterministic exports

Run `npm ci --include=dev` then `npm run icons`. The development-only
`@resvg/resvg-js` renderer exports the shared React logo component without a
browser or model request. The reusable logo SVG and 96px notification badge remain transparent.
The 32px favicon and 180/192/512px installed icons share the canonical
`public/branding/app-icon.svg`: fixed purple `#B39BFF` with the existing
`Icon(star)` geometry in green `#1fd60a`, overlapping the upper-left logo edge.
The header logo and theme filters remain unchanged. The
maskable mark fits inside the 40% radius safe circle. Source/output hashes and
dimensions are recorded in `public/branding/exports.json`. Existing dependency
license notices remain applicable.

The generator updates favicon, Apple icon, manifest and notification URLs using
content hashes. Device icon refresh has not been verified; an operating system
may retain an older installed icon until it refreshes the manifest.

## Remaining work

- `docs/screenshot.png`, `docs/first-run.png` and `docs/first-run.gif` are historical
  demonstration captures with the earlier logo. They have not been retouched or
  replaced with purported new screenshots.
- Desktop/mobile browser inspection and new neutral captures remain required.
  Automated DOM and colour checks do not constitute visual approval.

Do not describe the branding rollout as complete until these remaining supports
have been refreshed. Existing licenses and third-party attribution notices remain
unchanged. This work does not publish the repository or deploy any instance.
