# E-mail bridge

Other agents (a CI bot, another assistant, a colleague's agent) can write to your sessions by e-mail. Each one is an
**author** declared in `~/.config/weevils/env`:

```sh
WEEVILS_AUTHOR_HELPER=helper | #3fc1f0 | helper@example.com
WEEVILS_AUTHOR_CIBOT=ci-bot | #ff6b8a | ci@example.com | a-long-secret
```

(`name | color | e-mails | optional secret`). Their messages show in the threads signed with their name, in their
color. weevboss is told which author wrote what.

## Setup (Gmail)

1. Pick an alias of your inbox, e.g. `you+weevils@gmail.com`. No Gmail filter is needed.
2. Create an app password (Google account → Security → App passwords).
3. In `~/.config/weevils/env`:
   ```sh
   WEEVILS_MAIL_ADDRESS=you+weevils@gmail.com
   WEEVILS_MAIL_PASSWORD=<the app password>
   ```
   The bridge picks the change up by itself within a few seconds (no restart).

Other providers work too: set `WEEVILS_MAIL_IMAP`, `WEEVILS_MAIL_SMTP` and `WEEVILS_MAIL_AUTHSERV` (see
[`.env.example`](../.env.example)).

The bridge listens to INBOX (IMAP IDLE), but the IMAP server itself searches for mail addressed to the alias (`To`,
`Cc` or `Delivered-To`): only those are fetched (`BODY.PEEK`), and no other mail is ever read, marked, moved or
deleted. A `weevils` label (from an older setup with a Gmail filter) is read too if it exists and holds mail, with the
same search; `WEEVILS_MAIL_LABEL` names another one, `none` turns it off. After a restart the bridge resumes at the
last mail it handled; the first time it sees a folder, it picks up the alias's mail from the last 24 hours (each
message handled once, by `Message-ID`).

## Writing to a session

- **Subject = target**: `[project]` an available session of the project (otherwise a new one) ·
  `[session:2cbb0bbd]` that session · `[weevboss]` the orchestrator · `[new:project]` (or `[new:project:codex]`) a
  new session.
- **Body** = the message.
- **Reply**: sent back to the sender in the same thread; answering it continues the same session.

## Several authors on one address

Agents that write from **your own account** (ChatGPT with its Gmail connector, an agent using your mailbox) share
your address. Declare them with it (`WEEVILS_AUTHOR_GPT=gpt | #3fc1f0 | you@gmail.com`; weevboss does it for you) and
let them name themselves in each mail, case-insensitive: `[gpt]` in the subject, `[from:gpt]` or `from: gpt` at the
start of the body, or `— gpt` as a signature. A mail from your account with no such name is you. A mail with no target
goes to weevboss, whoever wrote it; replies drop the author's name and `[weevboss]` from the subject. Two authors sharing another address need the same naming (or their secret).

## Security

- Only declared senders (and your own account) get through, and only when their mail is authenticated: SPF or DKIM
  aligned on their domain (the receiving server's `Authentication-Results`), Gmail's `\Sent` label for mail sent
  from your own account, or the author's secret (`[key:…]` in the subject, or a `key: …` line in the body).
  Everything else is ignored, logged, and left unread.
- Rate limit per author (`WEEVILS_MAIL_PER_MINUTE`, `WEEVILS_MAIL_PER_HOUR`).
- No loops: the bridge's own mails are recognized by their headers (`X-Weevils`, its `Message-ID`), never by the
  address; nothing automatic (`Auto-Submitted`, `X-Autoreply`, `Precedence: bulk`); every reply goes to the sender
  only (never to the alias) and carries `Auto-Submitted: auto-replied`.

## Delivery

IMAP IDLE (push), re-armed every 30 s, automatic reconnection, dedup by Message-ID. Log:
`journalctl --user -u weevilsd | grep '\[mail\]'`.
