# Choreloop

A shared cleaning rotation for two people. Everything lives in this repo: the
app is a static page on GitHub Pages, the data is a JSON file in `data/`, and a
GitHub Actions cron sends the Friday afternoon push reminders. No server, no
database, no third-party account.

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
npm install
npm run setup
```

`npm run setup` generates the VAPID keypair, writes `config.js`, and uploads the
Actions secrets via the `gh` CLI (it prints them for manual entry if `gh` isn't
signed in). Then:

1. `git add -A && git commit -m "Set up Choreloop" && git push`
2. On GitHub: **Settings → Pages → Source: GitHub Actions**
3. Each of you creates a [fine-grained token](https://github.com/settings/personal-access-tokens/new)
   scoped to **this repo only**, with **Contents: Read and write**.
4. On each iPhone: open the Pages URL in Safari → Share → **Add to Home Screen**
   → open it from the icon → Settings → pick who you are, paste your token, and
   tap **Turn on reminders**.

Step 4's Home Screen part is not optional. iOS only delivers web push to a page
that has been installed to the Home Screen and opened from that icon.

## Day-to-day

Tap the checkbox next to a chore. That's it. Tapping a completed one again undoes
it and restores the previous turn.

The **Tasks** tab is where you change how often something comes around, switch it
between `alternate` and `each`, hand the next turn to a specific person, or edit
the instructions that go out in the reminder.

## Reminders

`.github/workflows/remind.yml` runs hourly across Friday (UTC) and
`scripts/send-reminders.mjs` decides which run is the right *local* moment, based
on `timezone` and `reminderHour` in `data/state.json`. Daylight saving is
therefore a non-issue and the cron never needs editing — change the hour in the
app's Settings tab instead.

It records who it has already told for a given weekend, so a run delayed by
GitHub still lands exactly once. A Sunday run acts as a catch-up if Friday's was
missed entirely.

Preview what the notifications will say, without sending anything:

```bash
npm run remind -- --dry-run
```

Send one right now (Actions tab → Weekend reminders → Run workflow) if you want
to test on a real phone.

## Local development

```bash
npm run preview
```

Serves the app at <http://localhost:8787> against a small emulator of the GitHub
contents API, reading and writing the real files in `data/`, so the app code runs
unmodified. Any non-empty string works as the token. Push notifications can't be
exercised locally — that needs the deployed HTTPS site.

## A note on repo visibility

GitHub Pages on a free personal account requires a **public** repo, so assume
this one is public. What that exposes is your two first names, your chore names
and instructions, and the dates things were done.

Push subscription endpoints live in `data/subscriptions.json` and are also
visible, but they are not usable on their own: every push must be signed with
the VAPID private key, which stays in Actions secrets. Your access tokens are
never committed — they live in each browser's `localStorage` only.

If you'd rather keep the history private, GitHub Pro allows Pages on a private
repo and nothing else here needs to change.

## Layout

```
index.html  app.js  styles.css     the app
schedule.js                        due dates and rotation, shared by app and cron
config.js                          repo + VAPID public key (written by setup)
sw.js  manifest.webmanifest        service worker and PWA install metadata
data/state.json                    people, tasks, and the completion log
data/subscriptions.json            one push subscription per person
data/reminders-sent.json           dedupe marker for the cron
scripts/send-reminders.mjs         builds and sends the Friday push
.github/workflows/                 Pages deploy + hourly Friday reminder cron
```
