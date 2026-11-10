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

1. Pick an alias of your inbox, e.g. `you+weevils@gmail.com`. Create a Gmail filter "to: you+weevils@gmail.com" →
   apply the label `weevils`, skip the inbox.
2. Create an app password (Google account → Security → App passwords).
3. In `~/.config/weevils/env`:
   ```sh
   WEEVILS_MAIL_ADDRESS=you+weevils@gmail.com
   WEEVILS_MAIL_PASSWORD=<the app password>
   ```
   then `weevils-service restart`.

Other providers work too: set `WEEVILS_MAIL_IMAP`, `WEEVILS_MAIL_SMTP` and `WEEVILS_MAIL_AUTHSERV` (see
[`.env.example`](../.env.example)).

The bridge only watches the `weevils` label (never INBOX), only handles mail sent to the alias, and never reads,
marks, moves or deletes any other mail.

## Writing to a session

- **Subject = target**: `[project]` an available session of the project (otherwise a new one) ·
  `[session:2cbb0bbd]` that session · `[weevboss]` the orchestrator · `[new:project]` (or `[new:project:codex]`) a
  new session.
- **Body** = the message.
- **Reply**: sent back to the sender in the same thread; answering it continues the same session.

## Security

- Only declared senders get through, and only when their mail is authenticated: SPF or DKIM aligned on their domain
  (the receiving server's `Authentication-Results`), or the author's secret (`[key:…]` in the subject, or a
  `key: …` line in the body). Everything else is ignored, logged, and left unread.
- Rate limit per author (`WEEVILS_MAIL_PER_MINUTE`, `WEEVILS_MAIL_PER_HOUR`).
- No loops: nothing from the bridge's own address and nothing automatic (`Auto-Submitted`, `X-Autoreply`,
  `Precedence: bulk`); every reply goes to the sender only and carries `Auto-Submitted: auto-replied`.

## Delivery

IMAP IDLE (push), re-armed every 30 s, automatic reconnection, dedup by Message-ID. Log:
`journalctl --user -u weevilsd | grep '\[mail\]'`.
