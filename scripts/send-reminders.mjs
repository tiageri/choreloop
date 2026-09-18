#!/usr/bin/env node
/**
 * Sends each person a push notification listing the chores they owe this
 * weekend, with the instructions for each one. Run by .github/workflows/remind.yml
 * on a Friday afternoon cron; run locally with --dry-run to preview.
 *
 * The cron fires every hour across Friday so daylight saving can never shift
 * the reminder; this script decides whether *now* is the right local moment and
 * records who it has already told, so a delayed run still lands exactly once.
 *
 * This script lives in the public app repo but the data lives in the private
 * one, so the directory is injected via CHORELOOP_DATA_DIR.
 *
 * Reads:  <data>/state.json, <data>/subscriptions.json, <data>/reminders-sent.json
 * Writes: <data>/reminders-sent.json, and <data>/subscriptions.json when the
 *         push service tells us a subscription is permanently gone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';
import { weekendPlan, personName, zonedParts } from '../schedule.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

const DATA_DIR = process.env.CHORELOOP_DATA_DIR
  ? path.resolve(process.env.CHORELOOP_DATA_DIR)
  : path.join(ROOT, 'data');

const STATE_PATH = path.join(DATA_DIR, 'state.json');
const SUBS_PATH = path.join(DATA_DIR, 'subscriptions.json');
const SENT_PATH = path.join(DATA_DIR, 'reminders-sent.json');

// Keep the payload comfortably under the ~4KB Web Push ceiling.
const MAX_BODY = 2400;
const MAX_INSTRUCTIONS_PER_TASK = 420;

const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
const subs = JSON.parse(fs.readFileSync(SUBS_PATH, 'utf8'));
const sentLog = JSON.parse(fs.readFileSync(SENT_PATH, 'utf8'));

const now = process.env.CHORELOOP_NOW ? new Date(process.env.CHORELOOP_NOW) : new Date();
const tz = state.timezone || 'UTC';
const plan = weekendPlan(state, now);

/* ---------- is this the right moment? ---------- */

// Key this weekend by its local Friday date so reruns can be deduplicated.
const wp = zonedParts(plan.window.start, tz);
const weekendKey = `${wp.year}-${String(wp.month).padStart(2, '0')}-${String(wp.day).padStart(2, '0')}`;
const alreadyTold = new Set(sentLog[weekendKey] || []);

const localNow = zonedParts(now, tz);
const reminderHour = state.reminderHour ?? 16;
const isWeekend = [5, 6, 0].includes(localNow.weekday);
const pastReminderTime = localNow.weekday !== 5 || localNow.hour >= reminderHour;

if (!DRY && !FORCE && !(isWeekend && pastReminderTime)) {
  console.log(
    `Not reminder time yet (${tz} says day ${localNow.weekday}, hour ${localNow.hour}; ` +
    `waiting for Friday ${reminderHour}:00). Nothing to do.`
  );
  process.exit(0);
}

function clip(text, limit) {
  const t = (text || '').trim();
  if (t.length <= limit) return t;
  return t.slice(0, limit).replace(/\s+\S*$/, '') + '…';
}

function buildMessage(personId, items) {
  const count = items.length;
  const p = zonedParts(plan.window.start, tz);
  const weekendOf = `${p.month}/${p.day}`;

  const title = count === 1
    ? '1 chore this weekend'
    : `${count} chores this weekend`;

  const names = items.map((a) => `• ${a.task.name}`).join('\n');
  let body = `Weekend of ${weekendOf}\n${names}`;

  for (const a of items) {
    const how = clip(a.task.instructions, MAX_INSTRUCTIONS_PER_TASK);
    if (!how) continue;
    const block = `\n\n${a.task.name.toUpperCase()}\n${how}`;
    if (body.length + block.length > MAX_BODY) {
      body += '\n\nOpen Choreloop for the rest of the steps.';
      break;
    }
    body += block;
  }

  return {
    title,
    body,
    url: process.env.CHORELOOP_URL || './',
    tag: `choreloop-${plan.window.start.toISOString().slice(0, 10)}-${personId}`,
  };
}

/* ---------- send ---------- */

if (!DRY) {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:choreloop@example.com';
  if (!pub || !priv) {
    console.error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set.');
    process.exit(1);
  }
  webpush.setVapidDetails(subject, pub, priv);
}

let sent = 0;
let pruned = false;

for (const person of state.people) {
  const items = plan.byPerson[person.id] || [];
  if (!items.length) {
    console.log(`${person.name}: nothing due — no push sent.`);
    continue;
  }

  if (!DRY && !FORCE && alreadyTold.has(person.id)) {
    console.log(`${person.name}: already reminded for the weekend of ${weekendKey}.`);
    continue;
  }

  const message = buildMessage(person.id, items);

  if (DRY) {
    console.log(`\n===== to ${person.name} =====`);
    console.log(message.title);
    console.log('-'.repeat(40));
    console.log(message.body);
    console.log(`[${Buffer.byteLength(JSON.stringify(message))} bytes]`);
    continue;
  }

  const sub = subs[person.id];
  if (!sub?.endpoint) {
    console.log(`${person.name}: ${items.length} due, but no device registered yet.`);
    continue;
  }

  try {
    await webpush.sendNotification(sub, JSON.stringify(message), { TTL: 60 * 60 * 36 });
    console.log(`${person.name}: sent ${items.length} chore(s).`);
    alreadyTold.add(person.id);
    sent++;
  } catch (err) {
    // 404/410 mean the subscription is permanently dead; anything else is transient.
    if (err.statusCode === 404 || err.statusCode === 410) {
      console.log(`${person.name}: subscription expired, removing. Re-enable in the app.`);
      delete subs[person.id];
      pruned = true;
    } else {
      console.error(`${person.name}: push failed (${err.statusCode}) ${err.body || err.message}`);
      process.exitCode = 1;
    }
  }
}

if (!DRY && alreadyTold.size) {
  // Keep only the last few weekends so the file does not grow forever.
  sentLog[weekendKey] = [...alreadyTold];
  const recent = Object.keys(sentLog).sort().slice(-8);
  const trimmed = Object.fromEntries(recent.map((k) => [k, sentLog[k]]));
  fs.writeFileSync(SENT_PATH, JSON.stringify(trimmed, null, 2) + '\n');
}

if (pruned) {
  fs.writeFileSync(SUBS_PATH, JSON.stringify(subs, null, 2) + '\n');
  console.log('Pruned expired subscriptions.');
}

if (!DRY) console.log(`Done. ${sent} notification(s) sent.`);
