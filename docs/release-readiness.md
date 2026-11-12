# Release candidate — 12 November 2026

Status: prepared in the private repository; **public visibility is blocked** pending the items below. No production or beta deployment is part of this preparation.

## Canonical source

The publication repository is `Sc4rville/weevils-oss`, branch `prepare/open-source-sync`, PR #1. Its default branch is still `main`. The development repository `Sc4rville/weevils` is separate and its full private history is not imported. The recovered publication baseline is `bf2b50d`, followed by official-logo commits `54ba3ac`, `177e4f5`, `7d5a22d`, recovered icon composition `f160f89`, and fixture/cleanup fix `8a0079e`. This is not a claim of parity with the latest private development branch.

## What is prepared

- Official approved bitmap, transparent derivative, shared UI logo, PWA icons, favicon and notification badge, with deterministic export hashes and provenance stripped of private mail identifiers.
- Apache-2.0 source/documentation license and package metadata, retained earlier MIT notice, NOTICE, runtime dependency attribution and build-time renderer notice.
- English installation instructions, own-account requirements, separate private data locations, and explicit limitations of Codex-only use.
- A single-user Docker source package with no host credentials, projects, mounts or Docker socket; permission prompts remain enabled.

## Validation

- Typechecks, i18n, shell syntax and required tests: 1,042 passed; one live-server test intentionally skipped. The disposable test-home cleanup now retries a concurrent-directory removal. A short private TMPDIR avoids this host's exhausted temporary-file quota and Unix socket path-length limit.
- Blank Ubuntu systemd installer suite passed all 57 checks: install, service startup, configuration, idempotent rerun, HTTPS proxy configuration, port changes, uninstall and reinstall. Claude login is a test stub in this suite; it does not validate a provider subscription.
- Codex CLI 0.167.0 installed successfully in the disposable Docker account; `codex --version` works and `codex login status` correctly reports no login. No authenticated Codex model request is claimed.
- Production build passed. Docker package built with `npm ci` from the lockfile and started with an empty account. Anonymous/invalid access rejection, secure cookie attributes, authenticated empty sessions/projects, logout and token revocation passed. No provider account was used.
- Gitleaks 8.30.1 found zero secrets in all 15 recovered reachable commits and the source tree. Both existing private draft archives were downloaded from GitHub, their SHA256SUMS verified, extracted, and scanned with zero secret findings. Final candidate history/tree scans and package checks are recorded in PR #1.
- Wider history review examined 775 reachable objects and identified 19 image/SVG/GIF blobs. Historical test fixtures include private project/task context: a zero-secret result is not privacy clearance. The candidate generalizes the direct private-task fixtures; earlier commits and draft archives retain their old content.
- Genuine phone/desktop browser visual acceptance and an authenticated first model result are not claimed. No connected physical-browser tool is available in this session. Provider login must be completed by the installing person; no existing account is borrowed.

## Remaining publication blockers

1. **Logo rights:** the supplied mark and its integration approval are verified; evidence of the original creation service, applicable terms and redistribution rights is still missing. Provenance alone is not a rights grant. Resolve for the original and its derivatives before public redistribution.
2. **Historical private context:** review or replace the historical task excerpts before exposing all existing branches, PR commits and old draft source assets. Cleaning only the current tree does not remove them. History rewriting, ref deletion or replacing draft assets has not been performed without an agreed publication-history decision.
3. **Default branch and release:** merge the reviewed candidate (or an approved sanitized publication history) and verify the default-branch install URL and final source archive. An authenticated Claude/Codex first-result acceptance remains outstanding. Codex session control is supported; a Codex-backed weevboss is not implemented.
4. **Visibility approval:** Yann must explicitly authorize changing `Sc4rville/weevils-oss` from private to public after the preceding blockers are resolved.

## What a visibility change exposes

Repository source and documentation, all reachable published branches/tags and their history, PR #1 discussion and commits, issues and repository metadata. Draft releases are currently private drafts; publishing those releases/assets is a separate action and requires the same review. User account homes, runtime access codes, provider logins, projects, sessions, preferences and memories are outside the repository and must remain private.

The intended simple URL for friends is https://github.com/Sc4rville/weevils-oss. Until visibility is approved, only invited collaborators can use it. Each person installs their own instance and signs in with their own provider account. Do not share an owner's running-instance login link as the open-source installation URL.
