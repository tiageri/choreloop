# Choreloop data

Private half of [Choreloop](https://github.com/__APP_REPO__). Holds the chore
state and the cron that sends the Friday reminders. Nothing here is served to
the web — the app reads it through the GitHub API using each person's token.

| File | What it is |
| --- | --- |
| `state.json` | People, tasks, and the full completion log |
| `subscriptions.json` | One push subscription per person |
| `reminders-sent.json` | Which weekends have already been notified |

`git log data/state.json` is the permanent record of who cleaned what, and when.

The app code — including the scheduling rules and the script this workflow runs
— lives in the public repo. This repo only ever holds data.
