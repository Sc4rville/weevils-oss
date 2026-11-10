Clean single-user trial

Requires Docker. Extract the source bundle, then:
  FRIEND_PORT=4286 FRIEND_URL=https://YOUR-DOMAIN bash scripts/friend/run.sh up
Proxy YOUR-DOMAIN over HTTPS to 127.0.0.1:4286, forwarding X-Forwarded-For.
  FRIEND_URL=https://YOUR-DOMAIN bash scripts/friend/run.sh link
The link is the login credential. Give it only to the intended user.

The named Docker volume weevils-friend-home holds ONLY this user's data, projects and provider login. No host files, credentials, Docker socket or CLI memory are mounted. The default safety mode asks before agent actions. No account is connected by the package.

First run:
1. Open the private login link and complete the introductory screens.
2. Choose Claude in setup. Sign in with YOUR account in the provider page.
3. Paste the authorization code into the dedicated setup form, not ordinary chat.
4. Ask: "Create a new local project called hello with a README.md saying Hello. Show me its contents."
5. Watch the created session and answer any permission request. GitHub is optional.

The human provider sign-in is required. The package never borrows the host's subscription. Codex, speech, dictation, extra machines, remote browser and GPU are optional capabilities. This container has no sudo or host administration access. Externally reachable app previews need a separate explicit proxy; only weevils itself is published by these instructions.

Restart without losing data: bash scripts/friend/run.sh start
Inspect: bash scripts/friend/run.sh status
Do not delete the named volume if you want to retain the user's data.
This is one account per container, not a shared multi-user service.

Update from a new source package, retaining the same HOME volume: bash scripts/friend/run.sh update
