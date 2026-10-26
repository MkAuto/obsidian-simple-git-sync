// Copies the build into the phone's test vault over USB debugging.
// ANDROID_VAULT=/sdcard/Documents/test-vault npm run deploy:android  (ADB=path/to/adb if adb isn't on PATH)
import { execFileSync } from 'node:child_process';

const vault = process.env.ANDROID_VAULT ?? '/sdcard/Documents/test-vault';
execFileSync(process.env.ADB ?? 'adb', ['push', 'main.js', 'manifest.json', 'styles.css', `${vault}/.obsidian/plugins/simple-git-sync/`], { stdio: 'inherit' });
