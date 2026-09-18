#!/usr/bin/env node
/**
 * One-time setup for the two-repo layout.
 *
 *   public  <owner>/<name>        this repo: app code, deployed to Pages
 *   private <owner>/<name>-data   chore state + the Friday reminder cron
 *
 * Creates both on GitHub, writes config.js, uploads the VAPID secrets, and
 * pushes. Requires the GitHub CLI to be signed in (`gh auth login`).
 */
import { execFileSync, execSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

/**
 * Answer order: environment variable, then the prompt, then the default.
 * The env path exists so the whole thing can run unattended — piping answers
 * into readline is unreliable, because stdin can close before the later
 * questions are even asked.
 */
async function ask(envKey, prompt, fallback) {
  const fromEnv = process.env[envKey];
  if (fromEnv !== undefined && fromEnv !== '') {
    console.log(`${prompt}${fromEnv}   (from ${envKey})`);
    return fromEnv;
  }
  // With no terminal attached there is nobody to answer, and a pending
  // readline question on a closed stdin never settles. Take the default.
  if (!process.stdin.isTTY) {
    console.log(`${prompt}${fallback}   (default)`);
    return fallback;
  }
  return (await rl.question(prompt)).trim() || fallback;
}

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString().trim();
const quiet = (cmd, args, opts) => { try { return run(cmd, args, opts); } catch { return null; } };
const step = (msg) => console.log(`\n• ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);

/* ---------- scaffolding ---------- */

/** Lay out the private data repo's files. Touches nothing on GitHub. */
function scaffoldDataRepo(dataDir, { you, them, timezone, appRepo }) {
  fs.cpSync(path.join(ROOT, 'template'), dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'data'), { recursive: true });

  // Seed the live state from the template, with the real names filled in.
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/seed.json'), 'utf8'));
  seed.people[0].name = you;
  seed.people[1].name = them;
  seed.timezone = timezone;
  fs.writeFileSync(path.join(dataDir, 'data/state.json'), JSON.stringify(seed, null, 2) + '\n');
  fs.writeFileSync(path.join(dataDir, 'data/subscriptions.json'), '{}\n');
  fs.writeFileSync(path.join(dataDir, 'data/reminders-sent.json'), '{}\n');

  // Point the template's placeholders at the real app repo.
  for (const rel of ['.github/workflows/remind.yml', 'README.md']) {
    const f = path.join(dataDir, rel);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll('__APP_REPO__', appRepo));
  }
}

// `--scaffold-only <dir>` builds the data repo's files and stops, so the layout
// can be checked without creating repos.
if (process.argv[2] === '--scaffold-only') {
  scaffoldDataRepo(path.resolve(process.argv[3]), {
    you: 'PersonA', them: 'PersonB', timezone: 'America/New_York', appRepo: 'owner/app',
  });
  console.log('scaffolded ' + process.argv[3]);
  process.exit(0);
}

/* ---------- preconditions ---------- */

if (quiet('gh', ['auth', 'status']) === null) {
  console.error('\nGitHub CLI is not signed in. Run:\n\n    gh auth login\n\nthen re-run `npm run setup`.');
  process.exit(1);
}

const viewer = JSON.parse(run('gh', ['api', 'user']));
const owner = viewer.login;

/* ---------- names ---------- */

const defaultName = path.basename(ROOT);
const appName = await ask('CLEANIT_APP', `Public app repo name [${defaultName}]: `, defaultName);
const dataName = await ask('CLEANIT_DATA', `Private data repo name [${appName}-data]: `, `${appName}-data`);

const appRepo = `${owner}/${appName}`;
const dataRepo = `${owner}/${dataName}`;
const pagesUrl = `https://${owner.toLowerCase()}.github.io/${appName}/`;

const you = await ask('CLEANIT_YOU', 'Your first name [Me]: ', 'Me');
const them = await ask('CLEANIT_THEM', "Roommate's first name [Roommate]: ", 'Roommate');
const timezone = await ask('CLEANIT_TZ', 'Time zone [America/New_York]: ', 'America/New_York');
try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
catch { console.error(`"${timezone}" is not a valid IANA time zone.`); process.exit(1); }
const contact = await ask('CLEANIT_CONTACT',
  'Contact email for the push services [cleanit@example.com]: ', 'cleanit@example.com');

console.log(`
  public   ${appRepo}        ->  ${pagesUrl}
  private  ${dataRepo}
`);
const confirm = await ask('CLEANIT_YES', 'Create these on GitHub and push? [y/N] ', 'n');
if (!/^(y|1|true)/i.test(confirm)) {
  console.log('Nothing done.');
  process.exit(0);
}

/* ---------- keys ---------- */

const b64url = (b) => Buffer.from(b).toString('base64url');
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pj = publicKey.export({ format: 'jwk' });
const vapidPublic = b64url(Buffer.concat([
  Buffer.from([4]), Buffer.from(pj.x, 'base64url'), Buffer.from(pj.y, 'base64url'),
]));
const vapidPrivate = b64url(Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url'));

/* ---------- 1. the private data repo ---------- */

step(`Building the private data repo at ../${dataName}`);
const dataDir = path.join(path.dirname(ROOT), dataName);
if (fs.existsSync(dataDir)) {
  console.error(`  ${dataDir} already exists. Move it aside and re-run.`);
  process.exit(1);
}

scaffoldDataRepo(dataDir, { you, them, timezone, appRepo });
ok('files written');

run('git', ['init', '-q', '-b', 'main'], { cwd: dataDir });
run('git', ['add', '-A'], { cwd: dataDir });
run('git', ['-c', `user.name=${viewer.login}`, '-c', `user.email=${viewer.id}+${viewer.login}@users.noreply.github.com`,
  'commit', '-q', '-m', 'CleanIt data: initial state and reminder cron'], { cwd: dataDir });
run('gh', ['repo', 'create', dataRepo, '--private', '--source', dataDir, '--remote', 'origin', '--push']);
ok(`${dataRepo} created (private) and pushed`);

/* ---------- 2. config + the public app repo ---------- */

step('Writing config.js');
fs.writeFileSync(path.join(ROOT, 'config.js'),
`// Written by \`npm run setup\`. Safe to commit: the VAPID public key is meant to
// be public, \`repo\` only names the private data repo, and the token that
// authorizes reads and writes lives in each browser's localStorage.
window.CLEANIT_CONFIG = {
  repo: ${JSON.stringify(dataRepo)},
  branch: "main",
  dataPath: "data/state.json",
  subsPath: "data/subscriptions.json",
  vapidPublicKey: ${JSON.stringify(vapidPublic)},
};
`);
ok(`points at ${dataRepo}`);

step(`Publishing ${appRepo}`);
run('git', ['add', '-A'], { cwd: ROOT });
if (quiet('git', ['diff', '--cached', '--quiet'], { cwd: ROOT }) === null) {
  run('git', ['commit', '-q', '-m', 'Point CleanIt at its private data repo'], { cwd: ROOT });
}
if (quiet('git', ['remote', 'get-url', 'origin'], { cwd: ROOT })) {
  run('git', ['push', '-u', 'origin', 'main'], { cwd: ROOT });
} else {
  run('gh', ['repo', 'create', appRepo, '--public', '--source', ROOT, '--remote', 'origin', '--push']);
}
ok(`${appRepo} created (public) and pushed`);

/* ---------- 3. secrets and Pages ---------- */

step('Uploading secrets to the data repo');
for (const [key, value] of [
  ['VAPID_PUBLIC_KEY', vapidPublic],
  ['VAPID_PRIVATE_KEY', vapidPrivate],
  ['VAPID_SUBJECT', `mailto:${contact}`],
]) {
  run('gh', ['secret', 'set', key, '--repo', dataRepo, '--body', value]);
  ok(key);
}
run('gh', ['variable', 'set', 'CLEANIT_URL', '--repo', dataRepo, '--body', pagesUrl]);
ok('CLEANIT_URL');

step('Turning on GitHub Pages');
try {
  execSync(`gh api -X POST repos/${appRepo}/pages -f build_type=workflow`, { stdio: 'ignore' });
  ok('Pages set to build from GitHub Actions');
} catch {
  try {
    execSync(`gh api -X PUT repos/${appRepo}/pages -f build_type=workflow`, { stdio: 'ignore' });
    ok('Pages set to build from GitHub Actions');
  } catch {
    console.log(`  ! Could not enable it automatically.
    Do it by hand: https://github.com/${appRepo}/settings/pages -> Source: GitHub Actions`);
  }
}

console.log(`
Done.

  App     ${pagesUrl}
  Data    https://github.com/${dataRepo}  (private)

Each of you, once:
  1. Make a fine-grained token at
       https://github.com/settings/personal-access-tokens/new
     Resource owner ${owner}, repository access: only ${dataRepo},
     Repository permissions -> Contents: Read and write.
  2. On your iPhone open ${pagesUrl} in Safari,
     Share -> Add to Home Screen, then open CleanIt from the icon.
  3. Settings -> pick who you are, paste the token, Turn on reminders.

The Home Screen step is required: iOS will not deliver web push to a page
running in a normal Safari tab.

Reminders go out Friday 4pm, Saturday 8pm and Sunday 5pm local, and only chase
whatever is still outstanding. Change those hours in the app's Settings tab.
`);

rl.close();
