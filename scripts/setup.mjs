#!/usr/bin/env node
/**
 * One-time setup: generates the VAPID keypair, writes config.js, and (if the
 * GitHub CLI is signed in) uploads the Actions secrets for you.
 *
 *   npm run setup
 */
import { execSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const tryShell = (cmd) => { try { return sh(cmd); } catch { return null; } };

/* ---------- 1. which repo? ---------- */

let repo = process.argv[2];
if (!repo) {
  const remote = tryShell('git remote get-url origin') || '';
  const guess = remote.match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1];
  repo = (await rl.question(`GitHub repo${guess ? ` [${guess}]` : ' (owner/name)'}: `)).trim() || guess;
}
if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) {
  console.error('Need a repo in owner/name form.');
  process.exit(1);
}

const branch = tryShell('git rev-parse --abbrev-ref HEAD') || 'main';
const [owner, name] = repo.split('/');
const pagesUrl = `https://${owner.toLowerCase()}.github.io/${name}/`;

/* ---------- 2. keys ---------- */

const b64url = (b) => Buffer.from(b).toString('base64url');
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pj = publicKey.export({ format: 'jwk' });
const vapidPublic = b64url(Buffer.concat([
  Buffer.from([4]), Buffer.from(pj.x, 'base64url'), Buffer.from(pj.y, 'base64url'),
]));
const vapidPrivate = b64url(Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url'));

const contact = (await rl.question('Contact email for the push services [choreloop@example.com]: ')).trim()
  || 'choreloop@example.com';

/* ---------- 3. write config ---------- */

fs.writeFileSync(path.join(ROOT, 'config.js'),
`// Written by \`npm run setup\`. Safe to commit: the VAPID public key is meant
// to be public, and the token that authorizes writes lives only in your browser.
window.CHORELOOP_CONFIG = {
  repo: ${JSON.stringify(repo)},
  branch: ${JSON.stringify(branch)},
  dataPath: "data/state.json",
  subsPath: "data/subscriptions.json",
  vapidPublicKey: ${JSON.stringify(vapidPublic)},
};
`);
console.log('\n✓ config.js written');

/* ---------- 4. secrets ---------- */

const ghReady = tryShell('gh auth status') !== null;
if (ghReady) {
  try {
    for (const [key, value] of [
      ['VAPID_PUBLIC_KEY', vapidPublic],
      ['VAPID_PRIVATE_KEY', vapidPrivate],
      ['VAPID_SUBJECT', `mailto:${contact}`],
    ]) {
      execSync(`gh secret set ${key} --repo ${repo} --body ${JSON.stringify(value)}`, { stdio: 'ignore' });
      console.log(`✓ secret ${key} set`);
    }
    execSync(`gh variable set CHORELOOP_URL --repo ${repo} --body ${JSON.stringify(pagesUrl)}`, { stdio: 'ignore' });
    console.log('✓ variable CHORELOOP_URL set');
  } catch (e) {
    console.log(`\n! Could not set them automatically (${e.message.split('\n')[0]}).`);
    printManualSecrets();
  }
} else {
  console.log('\n! GitHub CLI not signed in — add these by hand.');
  printManualSecrets();
}

function printManualSecrets() {
  console.log(`\n  Settings → Secrets and variables → Actions, on ${repo}:\n`);
  console.log(`    Secret   VAPID_PUBLIC_KEY   ${vapidPublic}`);
  console.log(`    Secret   VAPID_PRIVATE_KEY  ${vapidPrivate}`);
  console.log(`    Secret   VAPID_SUBJECT      mailto:${contact}`);
  console.log(`    Variable CHORELOOP_URL      ${pagesUrl}`);
}

console.log(`
Next:
  1. git add -A && git commit -m "Set up Choreloop" && git push
  2. On GitHub: Settings → Pages → Source: "GitHub Actions"
  3. Each of you: make a fine-grained token at
       https://github.com/settings/personal-access-tokens/new
     scoped to ${repo} only, with Contents: Read and write.
  4. Open ${pagesUrl} on your iPhone in Safari, Share → Add to Home Screen,
     then open it from the icon, pick who you are, paste your token,
     and tap "Turn on reminders".
`);

rl.close();
