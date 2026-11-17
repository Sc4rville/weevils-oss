# Official weevils logo

The approved isometric weevil is the shared mark. Its original proportions and face edges are preserved. The bitmap is not redrawn for themes or output sizes.

| Surface | Source / status |
| --- | --- |
| Home, session, full screen, voice, onboarding | `src/ui/logo.tsx`, shared `public/branding/weevboss-cutout.png`, four isolated CSS theme filters |
| README / reusable content | `public/branding/weevboss.svg`, deterministic export of that component with the light-theme tone |
| Browser favicon | `public/favicon-32.png`, fixed purple background and green working star, 32×32 |
| Notification badge | `public/badge-96.png`, transparent, 96×96; OS uses the weevil silhouette rather than a solid square |
| Canonical app icon | `public/branding/app-icon.svg`, official mark plus existing working star overlapping its upper-left body plane; fixed purple/green independent of selected theme |
| Apple home screen | `public/icon-180.png`, opaque, 180×180 |
| PWA / notification | `public/icon-192.png`, opaque, 192×192 |
| Maskable PWA | `public/icon-512.png`, opaque, 512×512; complete mark inside the 40% radius safe circle |
| Preview | `/logo-preview.html`, four themes, home/session/recording and installed-icon sizes |
| Existing screenshots / GIF | `docs/screenshot.png`, `docs/first-run.png`, `docs/first-run.gif` are historical captures, pending genuine recapture; never painted over |
| OSS | Separate owner integrates the same committed exports into `prepare/open-source-sync`; no OSS deployment here |
| Marketing sources | `weevils-content/compose/lib/brand.js` uses the exported SVG for stills and clip end cards |
| Marketing renders | Existing captures, posters, videos and gallery copies require recapture/render from source; see that repository's `BRANDING.md` |
| For you / gallery | Uses existing app components or source media. Do not replace historical evidence or unrelated TLO media; source-media review owned by feed session |

## Regeneration and cache

Run `npm install --include=dev` then `npm run icons`. The development-only SVG rasterizer exports the actual React logo component, embeds the approved PNG, and uses the same sRGB brightness as the light theme. No browser, model generation, original-image editing or production API is involved. Source and output hashes/dimensions are recorded in `public/branding/exports.json`.

The generator updates favicon, Apple icon, manifest and notification icon URLs with their content hashes. The service worker does not cache assets. Existing installed home-screen icons may be retained by the operating system until it refreshes the manifest; no claim of device refresh is made without checking the device.

The reusable logo SVG and notification badge have transparency. The favicon and installed app icons use the same fixed purple background and green working star, with the existing square-ended geometry and black outline. The full logo and star fit the maskable safe area. Theme filters affect the header/UI logo alone; switching themes does not recolour the installed icon.

## Validation and limits

Tests check source hash, export dimensions, alpha, opaque PWA backgrounds, maskable geometry and versioned references. Existing four-theme contrast tests cover the UI planes and recording colour. Export images are inspected directly. Browser screenshots at mobile/desktop sizes and installed-icon refresh remain unverified while the PC/browser is unavailable. No historical screenshot, private-account QR code or TLO render is modified.
