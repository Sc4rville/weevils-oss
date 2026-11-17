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
weevils page machine                                  # this install's live machine page (always there)
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

`machine` is built in: every install has one, `/p/report/weevils-machine`. It shows the stack (app → weevilsd →
weevboss, automations, pages → tmux, Claude hooks + JSONL, Codex app-server → sessions), each part lit from this
server's live state; what runs now with the machine's pulse (load, RAM, disk, Claude and Codex week); and what gets
better: the commits of weevils' own checkout over eight days as plain sentences per feature (a new one lands with an
animation), weevboss's goals, and the before/after shots shown with `weevils show`. The page polls `state.json`
every four seconds; nothing in it is made up: a part with no data says off or idle.

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
