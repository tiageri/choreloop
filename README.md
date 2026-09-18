# Choreloop

A shared cleaning rotation for two people. No server, no database, no
third-party account — it runs on two GitHub repos:

- **this repo (public)** — the app, a static page served by GitHub Pages, plus
  the scheduling rules and the reminder script
- **`<name>-data` (private)** — your names, chores, and the full completion log,
  plus the GitHub Actions cron that sends the Friday reminders

The split exists because free GitHub Pages only publishes from a public repo.
Keeping the data in a separate private repo means nothing personal is exposed:
this repo holds code only, and the deployed site is an empty shell until someone
signs in with a token.

- **Friday afternoon** each person gets a push listing the chores they owe that
  weekend, with the how-to steps for each one.
- **Tap a chore off** in the app. It records who did it and when, and the next
  turn goes to the other person.
- **History** is the permanent record — and because every change is a git
  commit, `git log data/state.json` is an even more complete one.

## How the rotation works

Each task carries its own frequency and its own "up next" person, so the two of
you split every weekend rather than trading whole weekends.

| Mode | Meaning |
| --- | --- |
| `alternate` | One of you does it; the turn flips to the other each time it's done. |
| `each` | You both do your own, every cycle, tracked separately. Used for the bathroom. |

A task appears on the weekend list when its due date (last done + frequency)
falls on or before that Sunday. Nothing is ever dropped: miss a weekend and it
carries over, marked how many days overdue it is.

The turn flips to whoever did *not* just do it — so if you cover for your
roommate, the next turn correctly goes back to them.

## Setup

```bash
gh auth login
npm install
npm run setup
```

`npm run setup` asks for your names and time zone, then creates the private data
repo from `template/`, generates the VAPID keypair, writes `config.js`, uploads
the Actions secrets, pushes both repos, and turns on Pages.

Then each of you, once:

1. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new)
   scoped to **the private data repo only**, with **Contents: Read and write**.
2. On your iPhone open the Pages URL in Safari → Share → **Add to Home Screen**
   → open Choreloop from the icon.
3. Settings → pick who you are, paste the token, tap **Turn on reminders**.

Step 2 is not optional. iOS only delivers web push to a page that has been
installed to the Home Screen and opened from that icon — a normal Safari tab
will never receive one.

## Day-to-day

Tap the checkbox next to a chore. That's it. Tapping a completed one again undoes
it and restores the previous turn.

The **Tasks** tab is where you change how often something comes around, switch it
between `alternate` and `each`, hand the next turn to a specific person, or edit
the instructions that go out in the reminder.

## Reminders

The cron lives in the **data** repo (`.github/workflows/remind.yml`, created from
`template/`). It checks out this repo for the code, runs hourly across Friday
UTC, and `scripts/send-reminders.mjs` decides which run is the right *local*
moment, based on `timezone` and `reminderHour` in the data repo's `state.json`.
Daylight saving is therefore a non-issue and the cron never needs editing —
change the hour in the app's Settings tab instead.

It records who it has already told for a given weekend, so a run delayed by
GitHub still lands exactly once. A Sunday run acts as a catch-up if Friday's was
missed entirely.

Preview what the notifications will say, without sending anything:

```bash
CHORELOOP_DATA_DIR=../choreloop-data/data npm run remind -- --dry-run
```

Send one right now (Actions tab → Weekend reminders → Run workflow) if you want
to test on a real phone.

## Local development

```bash
npm run preview
```

Serves the app at <http://localhost:8787> against a small emulator of the GitHub
contents API, so the app code runs unmodified. It works on a scratch copy in
`.preview-data/` (seeded from `data/seed.json`, gitignored), so experimenting
never touches the real data. Any non-empty string works as the token. Push
notifications can't be exercised locally — that needs the deployed HTTPS site.

## What is and isn't public

Public, in this repo: the app source, the scheduling rules, and `data/seed.json`
— the starting chore template, with no names and an empty log.

Private, in the data repo: your names, your live chore list and instructions,
every completion date, and your push subscriptions.

The deployed Pages site is reachable by URL but contains no data — it fetches
everything from the private repo using the token in your browser. Your tokens
are never committed; they live in each browser's `localStorage` only.

If you would rather have a single private repo, GitHub Pro allows Pages from
one. Then move `data/` and the cron back here and point `config.js` at this
repo.

## Layout

This repo (public):

```
index.html  app.js  styles.css     the app
schedule.js                        due dates and rotation, shared by app and cron
config.js                          data repo + VAPID public key (written by setup)
sw.js  manifest.webmanifest        service worker and PWA install metadata
data/seed.json                     starting chore template, no personal data
scripts/send-reminders.mjs         builds and sends the Friday push
scripts/setup.mjs                  creates both repos and wires them together
template/                          scaffold for the private data repo
.github/workflows/deploy.yml       publishes the app to Pages
```

The data repo (private):

```
data/state.json                    people, tasks, and the completion log
data/subscriptions.json            one push subscription per person
data/reminders-sent.json           dedupe marker for the cron
.github/workflows/remind.yml       hourly Friday cron; checks out this repo
```
