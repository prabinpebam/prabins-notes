# AGENTS.md

Instructions for AI coding agents (and people) working in this Focus Notes workspace. It's a notes repository, not source code: every file is a note, a setting, or the workflow that publishes them.

## Layout

```text
notes/                     PUBLIC notes, published on this repository's GitHub Pages site
private/                   Git submodule: the PRIVATE repository (added by the desktop app's setup)
  notes/                   private notes, never published as plain text
  access.json              share audiences and the vault's grant (secrets: never copy them anywhere)
  .focus-notes/            synced settings and custom themes
.focus-notes/workspace.json  the workspace format (formatVersion); don't change it by hand
.github/workflows/pages.yml  Deploy app: deploys the pinned, checksummed Focus Notes release
AGENTS.md, README.md       these instructions
```

- Folders inside `notes/` and `private/notes/` are the writer's own; keep them as they are.
- `.gitmodules` and `private/` appear once the desktop app has linked the private repository. Until then the workspace has public notes only.

## A note

- One `.md` file: UTF-8, LF line endings, one trailing newline. CommonMark with GitHub Flavored Markdown (tables, task lists, strikethrough, autolinks).
- **The first H1 is the title.** A note without an H1 is titled after its file name.
- **File names** are lowercase; letters and numbers in any language are kept with `.` and `_`, and any other run of characters becomes one hyphen (`On focus` → `on-focus.md`), at most 80 characters, unique within the folder ignoring case. Once a public note has been published, keep its name: renaming it changes its public address.
- **Front matter** is optional. Focus Notes only writes `id` (a stable identifier that keeps share links and redirects working). Never change or remove an `id`; keep every other key as it is.

```markdown
---
id: 01JA7Q8Z3M4N5P6R7S8T9V0W1X
---

# On focus

Writing happens one line at a time.
```

## Links

- Link between notes with **relative Markdown links**: `[see](../ideas.md)`. They work on GitHub, in any editor, and on the published site. No wiki links, no absolute paths.
- When you rename or move a note, update every relative link to it in the same commit, changing only the link's destination.
- **A public note must never link to a private one**: `notes/` is published, and a link would reveal a private file's name.

## `private/` rules

- **Never copy, quote, summarize, or move private content into `notes/`**, a commit message, an issue, a pull request, or any public place. Making a note public is the writer's decision, never yours.
- **Never make the private repository public**, and never add files from `private/` to this repository: it tracks only the submodule's pointer.
- **Never edit `private/access.json`'s secrets or keys** (`link`, `passcode`, `passcodeKey`, `salt`, `nameSalt`), and never print them. They open private notes on the site.
- Work in `private/` as its own repository: commit and push there **first**, then commit the pointer here (`git add private`). Don't push a pointer to a private commit that isn't pushed (`push.recurseSubmodules=check` stops it).
- Pull `private/` on its own (`git -C private pull`). Don't use `git pull --recurse-submodules` or `submodule.recurse`: the pointer can trail the private repository's `main`, and a recursive update would reset `private/` to an older commit.

## Commits

- Small commits with plain, short subjects that say what changed, the way the app writes them: `Update notes/on-focus.md`, `Create notes/ideas/tea.md`, `Rename notes/old.md → notes/new.md`, `Move 2 items to notes/archive`, `Update private notes to 1a2b3c4`. Several changes are counted in the subject (`Update 3 notes`) and listed below it.
- One logical change per commit; a rename or move and its link updates go together.
- Never rewrite published history (`git push --force`) and never skip hooks (`--no-verify`).
- Don't change `.github/workflows/pages.yml` or its pinned versions by hand. Updates come as pull requests from Focus Notes.
