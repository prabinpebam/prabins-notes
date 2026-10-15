# My notes

A [Focus Notes](https://github.com/prabinpebam/focus-notes) workspace: plain Markdown notes in my own GitHub account, with an app on my own GitHub Pages site.

- **Public notes** are in `notes/` and are published on this repository's Pages site.
- **Private notes** are in a separate private repository, linked here at `private/`. They're published only as ciphertext, which the vault passphrase opens in a browser, read-only.

## Getting started

1. Keep this repository public: GitHub Pages on free plans serves only public repositories.
2. **Settings → Pages → Source: GitHub Actions**, then **Actions → Deploy app → Run workflow**. It deploys the released app at the version pinned in `.github/workflows/pages.yml`, after checking its checksum and attestation.
3. Open `https://<your-username>.github.io/<this-repository>/`. Notes written there stay in that browser.
4. To save notes to GitHub, use the Focus Notes desktop app from the [releases page](https://github.com/prabinpebam/focus-notes/releases/latest). Its setup makes the private repository, links it at `private/`, adds a read-only deploy key, and sets your vault passphrase.

## Using Git yourself

```sh
git clone --recurse-submodules https://github.com/<you>/<this-repository>.git
git -C private checkout main
git -C private pull        # pull private/ on its own, never recursively
```

Commit and push in `private/` first, then commit the pointer here. More in [AGENTS.md](AGENTS.md).
