# Simple Git Sync

Keeps an Obsidian vault in sync with one git repository, on desktop and mobile, without merge conflicts.

It pulls when you open or return to the app and pushes shortly after you stop editing, so you rarely edit a stale copy. When two devices change the same lines anyway, the most recent change wins, the other version is kept in `.trash/simple-git-sync/`, and a notice lets you swap it back in.

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
| **Conflicts** | Where both devices changed the same lines, or one deleted a file the other changed, the device that changed the file last wins (by commit time; the remote on a tie). Edits elsewhere in the file are kept from both. The full losing version is copied to `.trash/simple-git-sync/<time>/`, and a notice offers **Show**: each file's losing version, with **Use this version** to bring it back. The **Show sync conflicts** command reopens it until the app restarts. |
| **Discard local changes** | Optional, per device, for a device you only read on, like a daily checklist. Once a day, at the time you choose, the device resets to the remote, unpushed commits included, after copying the discarded files to `.trash/simple-git-sync/`. Pulls in between keep your changes. Push and the pull timer are off while it's on. |
| **Errors** | Being offline is silent: the next trigger retries. Other errors show a notice. The full activity log is under Settings → Developer → Show sync log. |

All settings and the open-tabs layout are per device: the plugin adds its `data.json`, `workspace.json` and `workspace-mobile.json` to `.gitignore`.

## Engines

- **Native** (desktop default): the `git` program installed on your computer (version 2.38 or later), with your own SSH or credential setup.
- **Built-in** (mobile, optional on desktop): [isomorphic-git](https://isomorphic-git.org) over HTTPS with a token. isomorphic-git has no SSH support. Large repositories are slow and memory-hungry on phones.

## Disclosures

- **Network:** the plugin only talks to the git remote you configure, for fetch, push and clone. There's no telemetry.
- **Account:** you need an account with your git host. Mobile, and the built-in engine on desktop, need an access token.
- **Files:** the plugin edits the vault's `.gitignore`, adding its own `data.json`, the two workspace files and `.trash/`.
- **Running programs:** on desktop with the native engine, the plugin runs the `git` program installed on your computer, in the vault folder, through Node's `child_process`. It only ever runs `git`, with arguments the plugin builds itself, and never through a shell (`execFile`), so nothing it passes is read as a shell command. On mobile it runs no programs. With the built-in engine on desktop, it runs only `git config --get` once, when you switch to it, to fill in the URL and your name and email.

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
