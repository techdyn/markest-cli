# Changelog

## 0.3.0 — 2026-10-02

### Fixed
- If browser sign-in cannot start its local listener, the command now stops promptly with the error instead of keeping a five-minute wait alive.

### New
- **`markest login`** signs in with OAuth in your browser, choosing on the site what to allow. Over SSH, on a Linux with no display, or with `--device`, it shows a code to type at marke.st instead. `--with-key` keeps an API key, read from stdin and checked with the site first.
- **`markest logout`** ends the sign-in on the site and forgets it here. **`markest status`** says which credential the commands use and where it is kept.
- Commands use your sign-in first, then `MARKEST_API_KEY`, then a kept key; `MARKEST_AUTH=key` or `MARKEST_AUTH=oauth` chooses one. The access token is refreshed by itself.

### Changed
- **What the command keeps is encrypted:** the sign-in and the keys of encrypted artifacts are sealed under a key only your system's secret store holds, the Keychain, the Secret Service or Windows' Data Protection API.
  - Keys kept in `keys.json` by 0.2.0 move into `keys.vault` and that file is removed.
  - Where no secure store can be used, nothing is kept unless `--insecure-storage` (or `MARKEST_SECRET_STORE=file`) chooses a file only your account can read.
- `MARKEST_HOME` names the folder for everything the command keeps, replacing `MARKEST_KEYRING`.
- `markest mcp` acts as your sign-in, so an agent client needs no key in its configuration.

## 0.2.0 — 2026-10-01

### New
- **Artifacts encrypted end to end.** `markest publish --sealed` seals every document on your machine and sends only ciphertext; the address it prints carries the key. `read`, `pull` and `publish --update` open them with the key in their link or the one kept on this machine.
- **`markest mcp`:** a local MCP server with the tools for encrypted artifacts — create, read, write, remove documents, link, keys — for an AI agent beside the Markest connector, which cannot open them.
- **`markest keys`:** the keys of encrypted artifacts this machine keeps — listed, added from a link once it opens, forgotten.
- **Everything else the site does:** `draft` (no account), `read`, `pull`, `list`, `show`, `set`, `visibility`, `delete`, `images`, `versions`, `diff`, `restore`, `comments`, `reply`, `resolve`, `link`, `collaborators`, `fork`, `views`, `preview`, `grep`, and `tools` and `call` for any of the site's agent tools.

### Changed
- `markest --url <site> publish …`: a global flag before the command no longer has its value taken for the command.
- `markest` with no command, or `--help`, lists every command; `markest help <command>` shows one.
- `delete --json` refused partway adds a line saying which artifacts were already deleted.

### Fixed
- **Images a folder shows** are found as CommonMark reads them: an address with backslash escapes (`chart\_v2.png`) is the file it names; `\![a](x.png)` is a link, not an image; a blank line holding spaces, or written with Windows line endings, ends a paragraph; `&amp;` and the other character references in an HTML attribute are decoded. A local script not named `.js` is warned about like any other.
- **Titles:** an empty first heading (`# #`) no longer names the artifact "#", and a title ending in a hash (`# Learning C#`) keeps it.
- **`publish --update`:** the dry run, and the report of an update that fails, give the artifact's own title and opening document unless others are asked for, never the folder's.
- **`images --add`** refuses a file such as `notes.constructor`, which it took for an image.

## 0.1.0 — 2026-09-29

- `markest publish <folder>`: a folder as one artifact, its images uploaded and pointed at, `--update` sending only what changed.
