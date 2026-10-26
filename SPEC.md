# Simple Git Sync: spec

Agreed on 2026-10-26. Goal: no more merge conflicts from forgetting to pull, with Android as the main target.

## Listing

- id `simple-git-sync`, name "Simple Git Sync", author Keven B., MIT license.
- Repo `MkAuto/obsidian-simple-git-sync`, `minAppVersion` 1.11.4 (SecretStorage), not desktop-only.
- Community plugin store only. Pushing a tag (`1.2.3`, no `v`) publishes a GitHub release (not a draft).

## Engines

- **Native** (desktop default): runs the installed `git` on the existing `.git`, with the user's own SSH setup and prompts turned off.
- **Built-in** (always on mobile, optional on desktop): isomorphic-git over HTTPS through Obsidian's `requestUrl`. The token lives in Obsidian's SecretStorage.
- isomorphic-git has no SSH, so built-in always means HTTPS plus a token.

## Scope

The vault root, one branch, remote `origin`.

## Setup

- On a desktop that already has a `.git` folder, there's nothing to configure.
- With no `.git`, a clone dialog asks for the HTTPS URL, token, author name and email, and branch (default: the remote's default branch).
  - It clones into the vault, so the repo's `.obsidian/` replaces the local one. Local files whose content the repo replaces are copied to `.trash/simple-git-sync/<timestamp>/` first.
  - After a clone, the engine is Built-in on desktop too: the remote is HTTPS with the token, which native git would answer with the system's own credentials instead.
  - The repo is built in `.git-cloning/` and renamed to `.git/` only once every file is written. A clone that fails or is cut short leaves no `.git/`, so the dialog comes back instead of a sync committing the missing files as deleted. The next attempt removes the leftover `.git-cloning/` first.
  - It makes sure the plugin is still enabled in the cloned `community-plugins.json`, then reloads Obsidian.
- On first load, the plugin adds `.obsidian/plugins/simple-git-sync/data.json`, `.obsidian/workspace.json`, `.obsidian/workspace-mobile.json` and `.trash/` to `.gitignore`, and untracks those files if they were committed. All settings and the open-tabs layout are per-device, and trash (backups, plus files a pull deleted, which follow the user's trash preference as the store requires) never gets committed.
- When the built-in engine is active, its settings (HTTPS URL, token, name, email) show in the settings tab.
  - On mobile they're filled in by the clone dialog.
  - On desktop, the URL is filled in from `origin` (`git@github.com:X/Y.git` becomes `https://github.com/X/Y.git`), and the name and email come from the git config.

## Pull

- Triggers:
  - On open and on return to the app (toggle, default on).
  - Every N minutes (0 = off, the default).
  - A **Pull** command.
- Steps: commit local changes without pushing, fetch, merge.
- Where both sides changed the same lines, the remote wins. Edits elsewhere in the file are kept.
- The full local version of every file the remote overwrites is copied to `.trash/simple-git-sync/<timestamp>/<path>`, silently.

## Push

- Mode: off, N seconds after you stop editing (default 60), or every N minutes.
- "On background" toggle (default on, only applies when the mode isn't off).
- **Sync now** command and ribbon button, which always push.
- Steps: commit everything, pull (as above), push.
- Commit message: `Sync: {device} {YYYY-MM-DD HH:mm}`, with "Device name" as a per-device setting.

## Discard local changes (default off)

- Every pull resets the device to the remote, including unpushed commits.
- Discarded files are copied to `.trash/simple-git-sync/` first.
- While it's on, push is off and its settings are hidden.

## Feedback

- Successful syncs are silent.
- Network errors and "git busy" are silent and retried at the next trigger. Other errors show a notice.
- On desktop, the status bar shows "Synced 2 minutes ago" or "Syncing…".

## Developer

- A "Show sync log" toggle (off) reveals a read-only text box with the plugin's activity log.
  - It records what started each sync, every git command or call and its output, and every error, including silenced ones.
  - It's kept in memory only (last 1,000 lines, cleared on restart). The token is never written to it.
- The box shows the log as it was when settings opened. No buttons.

## Behaviour details

1. Only one sync runs at a time. A trigger that fires during a sync queues one more run.
2. Files written by a pull don't count as edits.
3. Changes under `.obsidian/` don't reset the idle timer. They go out with the next push from another trigger.
4. If git is busy (`index.lock`), the plugin shows git's error, which says to delete the lock if no other git program is running. The next trigger retries.
5. Desktop git runs with prompts disabled.
6. Copies go to `.trash/simple-git-sync/<timestamp>/<original path>`.
7. If `data.json` or a workspace file was ever committed, the plugin untracks it.
8. After a clone, the plugin makes sure it's enabled before reloading.
9. The built-in engine updates the files before it moves the branch, for merges and discards alike. If the app dies halfway, the next sync sees the updated files as local edits that agree with the remote.
10. Disabling the plugin lets a running sync finish and stops anything else: a pending idle push, a queued run.

## Development

- Built from the official sample plugin template, with its linting and release workflow.
- Runtime dependencies: `isomorphic-git`, `buffer`, `diff3`.
- Testing uses a throwaway GitHub repo and test vaults on both devices. Real vaults are never touched until the plugin is finished.
- The phone's test vault lives in shared storage. `npm run deploy:android` copies builds to it over adb, and `chrome://inspect` is used for debugging.
- One `node --test` file covers the logic that could lose data.

## Not included

SSH on mobile, multiple repos or branches, submodules, Git LFS, conflict files in the vault, iOS-specific work, BRAT.
