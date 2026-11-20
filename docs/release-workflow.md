# One product, one source

The product and source URL are **https://github.com/Sc4rville/weevils-oss**. Shared product improvements belong in this
repository, including fixes discovered while helping one person. There is no separate `weevils-oss` feature copy.
Personal configuration, accounts and data are not product source.

## How a change reaches installs

Merging to `main` is releasing. The setup server (`get/follow-main.sh`, every 2 minutes) picks up the new `main`
commit, runs `npm ci`, `npm run lint`, the tests and the build on it in a throwaway worktree, and only if they pass:
builds the bundle (`get/make-bundle.sh`: release-policy exclusions, a personal-trace check, signed by the
`weevils-signer` user), serves it, and mirrors the same revision to the public repository. A red commit is never
published: installs stay on the last good one. Every install's `weevils-update` then takes it within about 30
minutes, only if the signature checks and the snapshot is newer than the one installed.

## Every product change

1. Work from current canonical `main`, or an existing feature branch in this repository. Preserve other workers'
   dirty files. Use a separate worktree when needed; do not copy an old release tree back over current product code.
2. Implement the shared behavior in source and keep user configuration outside it. Run `npm run check` and the
   checks appropriate to the change (including blank installation checks when changing the installer).
3. Commit and push the owned changes. Give the integrator the branch, exact commit, checks/results and remaining
   limits. A memory note or local unpushed fix is not delivery. Integrate approved contributions from **all** workers
   into canonical `main` through normal review/merge before claiming them in the next release.
4. A release candidate is a fixed snapshot, not a development branch. New canonical commits make an older candidate
   stale. Continue development in the canonical repository and generate the next candidate from a new source SHA.

Unmerged work is pending integration, even when its private preview works. Preserve the universal onboarding work
and approved experience while integrating other fixes; do not silently drop one worker's changes during a release.
Report these revisions separately: **canonical source**, **candidate source**, **tested source**, **running build**.
Do not transfer test results from an older source to a newer one without identifying which files changed and what
was revalidated. A frontend build ID alone does not prove the backend revision or that a user completed AI login.

## RC2 is historical

`release/public-0.1.0-rc.2` remains immutable at `5798ba21aeab1b817fb8f00a1b816056dde80825`. Its filtered canonical
source was `ba46ee0f0750ebfd1c3cbcd619060b9741fe85e0`; its recorded application base was
`099b4202f994bcacb02793e4dedb72577f54da75`. The wording and test counts inside that snapshot describe that historical
release. They do not describe today's `main`. Do not move the ref, replace its assets, change its running instance,
or advertise it as the latest product. Its validation remains available in `docs/release-validation.json` on that ref.

## Check staleness

Run from a checkout containing this workflow. Fetching updates Git metadata, not another worker's files:

```sh
git fetch --no-tags origin main
python3 scripts/release.py status
```

The default comparison is the fetched `origin/main` against RC2. Exit **2** means stale, **0** means exact recorded
source/file parity, and **1** means unavailable or invalid evidence. An unknown legacy source is never called current.
The helper uses the selected Git ref; it does not silently fetch or claim that a cached tracking ref is live GitHub.
Use `--canonical HEAD` only to inspect an explicitly named review branch before integration.

Optional `--tested <sha>` and `--running <sha>` show separately reported revisions; they **do not assert** that checks
passed or inspect a server. Obtain those SHAs from actual check receipts and deployment/build evidence. Preserve
their evidence outside public source. Missing evidence stays unknown. None of these commands touch a running service.

## Generate the next private candidate

After integration and fetching, export directly from committed Git objects, never from the working directory:

```sh
python3 scripts/release.py export --source origin/main --output /private/release/weevils-next.tar.gz
python3 scripts/release.py verify /private/release/weevils-next.tar.gz
tar -xOf /private/release/weevils-next.tar.gz weevils/release-manifest.json > /private/release/manifest.json
python3 scripts/release.py status --manifest /private/release/manifest.json
```

Choose a new private output path for each candidate. The helper refuses overwrites and creates a mode-0600 archive.
The same commit/policy produces identical archive bytes: sorted files, fixed metadata, no current clock, author email,
working-tree changes, Git directory or parent history. The embedded manifest records the source SHA/tree, policy hash,
and every exported file's Git blob, SHA-256 and mode. Verification checks every byte against that exact canonical tree.
New shared source files are included automatically; the narrow privacy policy is in `scripts/release-policy.json`.
No fixes are maintained in the export, and no old candidate is used as its source.

This is reproducible **private preparation**, not a safety or publication approval. The manifest deliberately marks
checks, clean installation and secret/asset review as unperformed or unrecorded. Run checks and a clean installation
against the generated candidate, scan its actual files/objects and assets, and keep results tied to its source SHA
and archive hash. If canonical `main` advances, report the difference or generate and validate a newer candidate.
Licensing, the approved logo/third-party notices and installer fixes must be integrated in canonical source; an export
does not silently inject prepared changes from an older branch. Do not claim Apache-2.0 while the exported source
still declares another license.

## Private data and publication

Keep HOME contents, configuration, tokens, accounts, SSH keys, cookies, login links/QRs, voice recordings, transcripts,
memory, private project data and recovery notes outside shared source. The policy excludes known historical personal
publications, internal notes and the private design kit, including the three removed optional inspiration images.
Path filtering is not a content secret scan: review fixtures, examples, assets and new tracked files before publication.
Do not remove the functional approved official logo because unrelated historical references were excluded.

The exporter creates only a source archive. It neither creates nor pushes a ref, release, invitation or public URL.
If a reviewed parentless Git snapshot is needed, derive it from this verified export, preserve the manifest, use a
new immutable ref in the canonical repository and push it privately. Never force-push, delete or rewrite old refs.
Making the existing repository public exposes its other refs/history too; a clean archive or parentless candidate
does **not** clear the preserved private history. Public visibility and final distribution need explicit owner approval.
Until then, friends need their own authorized access to the canonical private repository.

## Private preview access wrappers during builds

The canonical installation can register reviewed, token-free HTML wrappers in
`~/.local/share/weevils/private-previews/wrappers/`. The private
`build-wrappers.json` registration records their filenames and SHA-256 hashes,
plus the canonical Git common directory. Neither the wrappers nor this
registration belongs in Git or in a source export.

Vite emits the registered wrappers as build assets, including for a clean build
or a staging `--outDir`. The same checkout's worktrees share the registration;
independent clones, source exports and fresh users do not. Only registered HTML
is read, never adjacent JSON credentials. A missing, changed or symlinked wrapper
fails the build before output cleaning, so it cannot silently publish a partial
set. Review changed wrappers before explicitly registering their new hashes with
`registerPreviewWrappers` from `scripts/private-preview-wrappers.ts`.

Deployment must copy the complete successful build output. Existing private
wrapper exclusions may stay in place; on a fresh destination the wrappers must
also be copied from that build. Do not clean a live `dist` before producing a
successful staged build, or restore HTML from an older app bundle. The wrapper's
availability and its target preview's health are separate checks: HTTP 200 on an
access page does not prove that its destination works. Credentials remain behind
the authenticated file API and are fetched only by the signed-in browser.
