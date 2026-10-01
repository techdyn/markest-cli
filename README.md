# markest

Markest from the command line: publish a folder as one artifact, read and manage your artifacts, and work with artifacts **encrypted end to end** — sealed on your machine, so the site only ever holds ciphertext. It also runs a small **MCP server** that gives an AI agent the same end-to-end tools.

```bash
export MARKEST_API_KEY=mk_live_…          # from Account → API keys on marke.st
markest publish ./docs                     # prints the artifact's address
markest publish ./notes --sealed           # encrypted end to end; the address carries the key
markest read https://marke.st/p/01J…#key=… # opens it again, here
```

It needs Node 20.19 or later and has no dependencies. Until it is on npm, run it from a checkout with `node bin/markest.mjs`, or `npm link` to put `markest` on your PATH.

## Commands

| Command | |
|---|---|
| `publish <folder>` | Publish a folder as one artifact, or update one (`--update`); `--sealed` encrypts it end to end |
| `draft <file\|folder>` | Publish without an account: live for a day unless claimed |
| `read <artifact> [<path>]` | Print one document |
| `pull <artifact> <folder>` | Write every document into a folder |
| `list` | Your artifacts, filtered by words, folder or visibility |
| `show <artifact>` | One artifact's settings and documents |
| `set <artifact>` | Its title, folder, tags, opening document, expiry, password, burning, versions, image copies |
| `visibility <v> <artifact>…` | Make artifacts public, unlisted or private |
| `delete <artifact>… --yes` | Delete artifacts for good |
| `images <artifact>` | List, add (`--add`) or remove (`--remove`) its images |
| `versions <artifact> [<n>]` | Its version history, one version, or a document as it was |
| `diff <artifact> <from> [<to>]` | What changed between versions; `--changes <n>` for what one version changed |
| `restore <artifact> <n>` | Bring back a version, or one document from it |
| `comments [<artifact>]` | Read comment threads, with the ids to answer them by |
| `reply <comment-id> <text>` | Answer a comment (`-` reads the text from stdin) |
| `resolve <comment-id>…` | Resolve threads, or `--reopen` them |
| `link <artifact>` | Its link; `--signed` for a private one; an encrypted one's carries its key |
| `collaborators <artifact>` | List, add or remove the people who may read it |
| `fork <artifact>…` | Copy artifacts into your account |
| `views <artifact>…` | How often they were read |
| `preview <artifact>` | The picture it shows where it is listed |
| `grep <pattern>` | Search your artifacts' documents |
| `keys` | The keys of encrypted artifacts this machine keeps |
| `mcp` | Run the local MCP server for encrypted artifacts |
| `tools`, `call <tool>` | List and run any of the site's agent tools |

An artifact is named by its id or by any of its addresses. `markest help <command>` shows each command's options. Every command takes `--url <site>` (default `https://marke.st`, or `MARKEST_URL`) and `--json`, which prints one JSON object instead. A refusal is `{"error": …, "status": …}`; when `delete` or `pull` is refused partway, a second line says what was already done (`{"deleted": [...]}`) or what was refused (`{"refused": [...]}`).

**Which plan features they use.** `publish`, `draft`, `read`, `pull`, `list`, `show`, `set`, `visibility`, `delete`, `images` and `versions` use the REST API, which your plan's API access opens. `diff`, `restore`, `comments`, `reply`, `resolve`, `link --signed`, `collaborators`, `fork`, `views`, `preview`, `grep`, `tools` and `call` use the site's agent tools, which your plan's agent (MCP) access opens; the site says so when it does not.

## The key

`MARKEST_API_KEY` (or `MARKEST_KEY`), never a flag, so it stays out of your shell history. Give it the permissions the commands need: `create_paste` to publish and change, `read_own` to read and update, `list_own` to list, `delete_own` to delete and prune. The key is never printed, and is taken out of every message. `read` and `pull` need no key for a public or unlisted artifact, or a private one shared by a signed link; `draft` never sends one.

## Encrypted end to end

`publish --sealed` seals every document on your machine with a new key — AES-256-GCM, each document bound to its path and type, exactly as the site's own editor seals one in a browser — and sends only ciphertext. The address it prints carries the key after `#key=`, a part of a link no browser or tool ever sends to a server. Whoever has that link can read the artifact; the site cannot.

- It is never public, holds no images and keeps no version history. Its title, its documents' names and types, and its comments stay readable by the site.
- The key is kept on your machine (see **Keys** below), so `markest read <id>`, `markest pull <id>` and `markest publish <folder> --update <id>` need only its id. An update opens what is there, compares the texts and seals only what changed.
- Anyone can read it with its link: `markest read 'https://marke.st/p/01J…#key=…'` — no account needed. `--remember` keeps that key here too.
- `markest link <id>` prints the link that shares it, key and all.
- Lose the key and the artifact cannot be read by anyone, Markest included.

## Keys

The keys of encrypted artifacts are kept in one file in your account's settings folder — `%APPDATA%\markest\keys.json` on Windows, `~/Library/Application Support/markest/keys.json` on a Mac, `$XDG_CONFIG_HOME/markest/keys.json` or `~/.config/markest/keys.json` elsewhere — or where `MARKEST_KEYRING` says. It is readable by you alone where the system has file modes; on Windows your profile folder's permissions protect it.

```bash
markest keys                           # the artifacts whose keys are kept — never the keys
markest keys --add 'https://…#key=…'   # keep a key (opened first, so a wrong one is never kept)
markest keys --forget <artifact>
```

A key is kept when you publish or update an encrypted artifact, and when you read one with `--remember`.

## The MCP server: encrypted artifacts for an AI agent

The Markest connector your agent may already use cannot open encrypted artifacts: it runs on the site, and the site never has the key. `markest mcp` is a small MCP server that runs on your machine beside it and offers only the tools for them — `markest_sealed_create`, `markest_sealed_read`, `markest_sealed_write`, `markest_sealed_remove_documents`, `markest_sealed_link` and `markest_sealed_keys` — sealing and opening here, with the keys kept as above.

```bash
# Claude Code
claude mcp add markest-sealed -e MARKEST_API_KEY=mk_live_… -- markest mcp
```

For Claude Desktop, Cursor, VS Code or Codex, add a stdio server whose command is `markest` (or `node /path/to/bin/markest.mjs`) with the argument `mcp`, and `MARKEST_API_KEY` in its environment. It speaks the MCP revisions 2025-06-18, 2025-03-26 and 2024-11-05.

**What it cannot avoid:** text an agent reads or writes through these tools passes through its conversation, so the company running the agent's model sees it. Markest never does. Each tool says so to the agent.

## Publishing a folder

```bash
markest publish ./docs
markest publish ./docs --update https://marke.st/p/01J…
```

- Every document keeps its folder. The artifact opens on `--default`, else the root `README` or `index`, else the first document, and is called `--title`, else that document's front matter title or first heading, else the folder's name.
- The site decides each document's type: markdown, HTML or code.
- Every image a document shows is uploaded once, as its own bytes, and the reference in the document is pointed at it. That covers markdown `![alt](img/chart.png)` and `[label]: img/chart.png`, and HTML `src`, `srcset`, `poster`, icons and CSS `url()`. An image no document shows is not uploaded.
- stdout is the address alone, so `url=$(markest publish ./docs)` works. What was left out and why goes to stderr.
- Updating sends only what changed: images not already there, then the added and changed documents. A document you gave a title or a type in the editor keeps it. A document gone from the folder stays unless you pass `--prune`. No image is ever removed.

**Never sent:** hidden files and folders (`.env`, `.npmrc`, `.git/` …); dependency folders (`node_modules`, `__pycache__`); build output (`build`, `dist`, `vendor`, `coverage`, `target`) unless `--include-output`; files that look like they hold a key, by name (`credentials.json`, `service-account*.json`, `*.pem`, `*.tfstate` …) or by content (a private key, or a Markest, Stripe, GitHub, Slack or AWS token), unless named with `--allow-file`; whatever `.markestignore` or `--ignore` names (gitignore's patterns); symbolic links, which are never followed.

**What does not work on the site:** an HTML page cannot load a stylesheet or script from beside it, or open another page, inside the frame it is shown in — it is published, and the command warns you. A markdown link to an image, `[chart](chart.png)`, is a link, not an image. Every image is one request, so a folder of many images takes a while at your plan's API rate; the command waits as long as the site asks.

## Pulling

`markest pull <artifact> <folder>` writes every document at its path. A path that would land outside the folder, or go through a link, is refused, and then nothing is written; a file already there is left alone unless `--force`.

## Exit codes

| Code | |
|---|---|
| 0 | Done |
| 1 | Failed, refused by the site, or done only in part (`grep`: nothing matched) |
| 2 | Asked wrongly |
| 3 | Waiting for you to confirm publishing: the link to confirm is on stderr, and nothing is public until you open it |
| 4 | Refused before anything was sent: the folder cannot be published as it is |

## Development

```bash
npm test            # the tests, with node:test
npm run coverage    # with the coverage thresholds: lines 85, branches 70, functions 85
npm run mutate      # mutation testing with Stryker, per group of modules
```

`npm run mutate` holds each critical module (keys, sealing, what is written to disk, what keeps a key out of a message) to a mutation score of 80 and every other module to 60. Each mutant's tests end themselves, and run with a home folder of their own under `reports/mutation/`, so no mutant can reach your profile, key or key store.

The modules the command shares with the Markest site — paths, content types, limits, sealing — are in `src/site/`, copied from the site so both judge and seal alike.

## License

MIT — Copyright (c) 2026 Techster Ltd. Techster Dynamics is a trading name of Techster Ltd (Company No. 17005321).
