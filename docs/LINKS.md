# Living links

A result with something to look at or act on (leads, deals, a library, a report, a render) lives on a small page
that weevils serves itself, and weevboss, sessions and automations send its link instead of a text blurb. In the
weevboss thread and in For you, such a link is bold, in its kind's two colours, slowly drifting; a tap opens the
page inside the app.

## Publish

```sh
weevils page <folder|file> "Title" --kind <kind>      # a folder (its index.html opens) or one file
weevils page list <items.json> "Title" [--kind opportunities]   # an actionable list, built by weevils
weevils page library "Title" <folder>…                # a media library that sorts itself
weevils page machine                                  # this install's « How weevils works » page (always there)
weevils pages                                         # what is published
weevils page rm <slug>                                # unpublish
```

Each command prints a markdown link, `[Title](https://<weevils host>/p/<kind>/<slug>)`: paste it as is in a reply,
a brief or a `weevils post`. Automations may run `page` and `pages` too.

Kinds and their colours:

| kind | opens | colours |
|---|---|---|
| `opportunities` | leads, deals, calls to answer: something to act on | green |
| `library` | media, files, a collection to browse | violet |
| `preview` | a page or an app to try | blue |
| `report` | a summary, a table, an audit to read | amber |
| `render` | a video, a still, a finished piece | red |

`list` reads a JSON array, or an object with `items` or `leads`. Per item: `title` (or `name`), `url` (or
`officialUrl`), `source` (or `platform` + `author` / `organisation`), `why` (or `summary`, `fitWhy`, `benefit`),
`date` (or `postedAt`, `deadline`), `fit` (1–5, sorts the list), and one action: `copy` (or `reply`, a text the user
copies before opening the post) or `action: {label, url}`. Items whose `status` is skip, closed, stale, ineligible,
done or dismissed are left out.

`library` keeps, in each folder, the media of finished-work folders (`out`, `final`, `exports`, `shipped`,
`previews`, `og`, `cards`…) when there are any, otherwise all its media; grouped by project (the folders above) and
series (the folder inside), newest first; videos, clips, stills and cards. Hidden folders, `node_modules`, `renders`,
`frames`, `build`, `dist` are never walked. A video's poster is `<name>.poster.jpg` next to it.

`machine` is built in: every install has one, `/p/report/how-weevils-works`. It explains how weevils is made, not
what it is doing: a diagram of the pieces (app and voice → domain and sign-in → weevilsd → weevboss, For you, pages →
requests and goals, memory, automations → tmux, Claude Code hooks + transcripts, Codex app-server → sessions), the
pieces around it (notifications, relay and accounts, other machines, mail bridge, RunPod, storage, install), and the
life of one message from the phone to a session and back. Each piece opens into a few plain sentences and its files
in the repo; the words are in `server/i18n/architecture.ts`, the diagram and files in `server/pages.ts`. Its only
live part is a small mark on the pieces whose files main changed in the last day (the shared hub files, like server/index.ts and server/core.ts, don't count) (`state.json`, from the git
log of weevils' own checkout). No activity feed, no load, no quota: that is the app's job. It replaced the
`weevils-machine` live dashboard, which is removed at the next start.

## Where it lives

- The address is on the weevils host itself: `https://<your weevils address>/p/<kind>/<slug>`. Without a domain it
  is this machine's address (`http://127.0.0.1:4179/p/…`), which the app still recognises and opens.
- A published folder or file stays where it was made; the page follows its updates. It must be inside the projects
  folders or weevils' data folder. Pages built by weevils (`list`, `library`) live in `~/.local/share/weevils/pages/`.
- Never use a preview domain (`expose`) for these pages: those are public.

## Who can open it

- Private by default, always. `/p/…` opens only for a signed-in device (or this machine); anyone else gets the
  weevils sign-in, then the page.
- The files are served from `/api/page/<key>/<slug>/…`, a key that opens that one page and nothing else, in a
  sandbox without weevils' origin: the page's script cannot reach the API.
- Hidden files (`.env`, `.git`…) are never served; a library serves only the files it lists.

## Lifecycle

- Same kind and title: same page, same address. Publish again to update it.
- A `list` page rebuilds itself when its JSON changes; a `library` page rescans its folders when opened, at most every
  ten minutes.
- A page whose folder is gone disappears from the list. `weevils page rm <slug>` unpublishes; for a page weevils
  built, its folder goes too. A published folder is never deleted by weevils.

## Default delivery and live reports

Every install publishes three private report pages: `/p/report/requests`, `/p/report/automations`, and
`/p/report/repositories`. They read the existing request ledger, recorded automation runs and local Git repository
inventory. They never dispatch, resume or reroute work. Requests retain their actual author and source message;
automation runs retain their source/config revisions and session IDs in the optional source details. Only recorded
runs appear: a queued task or an adopted repository alone is never a successful result. The request/run lists show
up to 150 recent records, with goals alongside requests. Run outcomes are labelled reported success/failure, not
independent verification. Original quotations and identifiers are preserved.

These reports refresh when opened and poll their keyed, read-only `items.json` once a minute while visible. An open
source disclosure pauses replacement so it stays readable. A failed read keeps the last good page; the live endpoint
returns an error rather than a fabricated empty or successful result. No private source paths or credentials enter
shared source. For you preserves named and bare living links even when its short headline removes Markdown or
technical paths; tapping the link opens the page directly, without sending a request to weevboss.

The shared result-delivery rule reaches both project agent launch paths and weevboss's generated instructions.
Questions and acknowledgements stay short; inspectable results use a verified private page link. Existing sessions
receive new launch instructions when next launched, not through an injected turn. Automation instructions retain
execution restrictions. Existing Opportunity hunter publication already uses the shared list builder; a publisher
must successfully obtain its page link before announcing delivery. This does not authorize spending or external
publication.

Rendered contrast can be checked with `scripts/check-living-links.mjs`, supplying an optional external Playwright
module and Chromium executable through `WEEVILS_PLAYWRIGHT` and `WEEVILS_BROWSER`. It uses the actual application
styles and screenshot pixels at phone and desktop widths, including all palette bands, result bands, outside authors,
thread bubbles and five positions of the For you gradient. It does not replace checking a real iPhone.
