# Simple Git Sync

Keeps an Obsidian vault in sync with one git repository, on desktop and mobile, without merge conflicts.

It pulls when you open or return to the app and pushes shortly after you stop editing, so you rarely edit a stale copy. When two devices change the same lines anyway, the remote version wins and your local version is kept in `.trash/simple-git-sync/`.

## Setup

**Desktop, vault already a git repository:** install and enable the plugin. It uses your installed git and SSH keys. Nothing to configure.

**Mobile, or any vault without a `.git` folder:** create an empty vault, install and enable the plugin, and fill in the clone dialog:

- Repository URL over HTTPS, for example `https://github.com/you/notes.git`.
- A token. On GitHub, use a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with access to this repository only and **Contents: read and write**. It's stored in Obsidian's secret storage, never in the vault.
- Author name and email for commits from this device.
- The branch.

The repository's files, including its `.obsidian` folder, replace the vault's, then Obsidian reloads. Local files it replaces are copied to `.trash/simple-git-sync/` first. A vault cloned this way uses the built-in engine, on desktop too.

## What it does

| | |
|---|---|
| **Pull** | On open and on return to the app, optionally every N minutes, and the **Pull** command. Local changes are committed (not pushed) first. |
| **Push** | N seconds after you stop editing (default 60), every N minutes, or off. Also when the app goes to the background, best effort. **Sync now** (command and ribbon button) always pushes. |
| **Conflicts** | Where both sides changed the same lines, the remote wins. Your edits elsewhere in the file are kept. The full local version of every overwritten file is copied to `.trash/simple-git-sync/<time>/`. |
| **Discard local changes** | Optional, per device. Every pull resets the device to the remote, unpushed commits included, after copying the discarded files to `.trash/simple-git-sync/`. Push is off while it's on. |
| **Errors** | Being offline is silent: the next trigger retries. Other errors show a notice. The full activity log is under Settings → Developer → Show sync log. |

All settings and the open-tabs layout are per device: the plugin adds its `data.json`, `workspace.json` and `workspace-mobile.json` to `.gitignore`.

## Engines

- **Native** (desktop default): the `git` program installed on your computer (version 2.38 or later), with your own SSH or credential setup.
- **Built-in** (mobile, optional on desktop): [isomorphic-git](https://isomorphic-git.org) over HTTPS with a token. isomorphic-git has no SSH support. Large repositories are slow and memory-hungry on phones.

## Disclosures

- **Network:** the plugin only talks to the git remote you configure, for fetch, push and clone. There's no telemetry.
- **Account:** you need an account with your git host. Mobile, and the built-in engine on desktop, need an access token.
- **Files:** the plugin edits the vault's `.gitignore`, adding its own `data.json`, the two workspace files and `.trash/`. On desktop with the native engine, it runs the installed `git` program in the vault folder.

Only GitHub is tested. Other HTTPS git hosts that accept a token as the password should work.

## Development

```bash
npm install
npm run dev                # watch build
npm test                   # git merge, backup and discard scenarios against local repos
npm run lint
ANDROID_VAULT=/sdcard/Documents/test-vault npm run deploy:android
```

Debug on Android with USB debugging and `chrome://inspect`. To release, run `npm version patch` and push the tag; the workflow publishes the GitHub release.
