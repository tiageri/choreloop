#!/usr/bin/env node
/**
 * Sends each person the chores they still owe this weekend, in three stages:
 *
 *   friday    the weekend's list, with the how-to steps
 *   saturday  what is still outstanding, due tomorrow
 *   sunday    final call, must be finished tonight
 *
 * Anyone who has already finished gets nothing — the later stages only chase
 * what is actually left.
 *
 * The cron fires hourly across the weekend so daylight saving can never shift
 * the timing; this script decides which stage the current local moment belongs
 * to and records who it has told, so a delayed run still lands exactly once.
 *
 * This script lives in the public app repo but the data lives in the private
 * one, so the directory is injected via CLEANIT_DATA_DIR.
 *
 * Reads:  <data>/state.json, <data>/subscriptions.json, <data>/reminders-sent.json
 * Writes: <data>/reminders-sent.json, and <data>/subscriptions.json when the
 *         push service tells us a subscription is permanently gone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';
import { weekendPlan, zonedParts } from '../schedule.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const stageOverride = process.argv.find((a) => a.startsWith('--stage='))?.split('=')[1];

const DATA_DIR = process.env.CLEANIT_DATA_DIR
  ? path.resolve(process.env.CLEANIT_DATA_DIR)
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

const now = process.env.CLEANIT_NOW ? new Date(process.env.CLEANIT_NOW) : new Date();
const tz = state.timezone || 'UTC';
const plan = weekendPlan(state, now);

/* ---------- which stage is it? ---------- */

// Position within the weekend: Friday 0, Saturday 1, Sunday 2.
const DAY_INDEX = { 5: 0, 6: 1, 0: 2 };

const STAGES = [
  { id: 'friday', day: 0, hour: state.reminderHour ?? 16 },
  { id: 'saturday', day: 1, hour: state.saturdayHour ?? 20 },
  { id: 'sunday', day: 2, hour: state.sundayHour ?? 17 },
];

const localNow = zonedParts(now, tz);
const todayIndex = DAY_INDEX[localNow.weekday];

const hasTriggered = (stage) =>
  todayIndex !== undefined &&
  (todayIndex > stage.day || (todayIndex === stage.day && localNow.hour >= stage.hour));

// The most recent stage whose moment has passed. Anything earlier is stale:
// if Friday's run was missed, Saturday's message is the one worth sending.
const currentStage = [...STAGES].reverse().find(hasTriggered);
const stage = stageOverride
  ? STAGES.find((s) => s.id === stageOverride)
  : currentStage;

if (!stage) {
  console.log(
    `Nothing due yet (${tz} says day ${localNow.weekday}, hour ${localNow.hour}). ` +
    `First reminder goes out Friday at ${STAGES[0].hour}:00.`
  );
  process.exit(0);
}

// Every stage up to and including this one counts as handled, so a stale
// earlier message can never arrive late.
const supersededIds = STAGES.slice(0, STAGES.findIndex((s) => s.id === stage.id) + 1)
  .map((s) => s.id);

/* ---------- the message ---------- */

const wp = zonedParts(plan.window.start, tz);
const weekendKey = `${wp.year}-${String(wp.month).padStart(2, '0')}-${String(wp.day).padStart(2, '0')}`;

// Tolerate the old flat-array shape from before staged reminders existed.
const rawEntry = sentLog[weekendKey];
const weekendLog = Array.isArray(rawEntry) ? { friday: rawEntry } : { ...(rawEntry || {}) };

function clip(text, limit) {
  const t = (text || '').trim();
  if (t.length <= limit) return t;
  return t.slice(0, limit).replace(/\s+\S*$/, '') + '…';
}

const COPY = {
  friday: (n) => ({
    title: n === 1 ? '1 chore this weekend' : `${n} chores this weekend`,
    lead: `Weekend of ${wp.month}/${wp.day}`,
  }),
  saturday: (n) => ({
    title: n === 1 ? '1 chore left — due tomorrow' : `${n} chores left — due tomorrow`,
    lead: 'Still outstanding. These need to be done Sunday.',
  }),
  sunday: (n) => ({
    title: n === 1 ? 'Last call: 1 chore' : `Last call: ${n} chores`,
    lead: 'These need to be finished by tonight, as agreed.',
  }),
};

function buildMessage(personId, items) {
  const { title, lead } = COPY[stage.id](items.length);
  const names = items.map((a) => `• ${a.task.name}`).join('\n');
  let body = `${lead}\n${names}`;

  for (const a of items) {
    const how = clip(a.task.instructions, MAX_INSTRUCTIONS_PER_TASK);
    if (!how) continue;
    const block = `\n\n${a.task.name.toUpperCase()}\n${how}`;
    if (body.length + block.length > MAX_BODY) {
      body += '\n\nOpen the app for the rest of the steps.';
      break;
    }
    body += block;
  }

  return {
    title,
    body,
    url: process.env.CLEANIT_URL || './',
    tag: `cleanit-${weekendKey}-${stage.id}-${personId}`,
  };
}

/* ---------- send ---------- */

if (!DRY) {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:cleanit@example.com';
  if (!pub || !priv) {
    console.error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set.');
    process.exit(1);
  }
  webpush.setVapidDetails(subject, pub, priv);
}

console.log(`Stage: ${stage.id} (weekend of ${weekendKey}, ${tz})`);

let sent = 0;
let pruned = false;
const told = new Set(weekendLog[stage.id] || []);

for (const person of state.people) {
  const items = plan.byPerson[person.id] || [];

  if (!items.length) {
    console.log(`${person.name}: all clear — nothing to chase.`);
    continue;
  }
  if (!DRY && !FORCE && told.has(person.id)) {
    console.log(`${person.name}: already sent the ${stage.id} reminder.`);
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
    await webpush.sendNotification(sub, JSON.stringify(message), { TTL: 60 * 60 * 12 });
    console.log(`${person.name}: sent ${stage.id} reminder (${items.length} chore(s)).`);
    told.add(person.id);
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

/* ---------- remember what went out ---------- */

if (!DRY && told.size) {
  for (const id of supersededIds) {
    weekendLog[id] = [...new Set([...(weekendLog[id] || []), ...told])];
  }
  sentLog[weekendKey] = weekendLog;
  // Keep only the last few weekends so the file does not grow forever.
  const recent = Object.keys(sentLog).sort().slice(-8);
  fs.writeFileSync(SENT_PATH,
    JSON.stringify(Object.fromEntries(recent.map((k) => [k, sentLog[k]])), null, 2) + '\n');
}

if (pruned) {
  fs.writeFileSync(SUBS_PATH, JSON.stringify(subs, null, 2) + '\n');
  console.log('Pruned expired subscriptions.');
}

if (!DRY) console.log(`Done. ${sent} notification(s) sent.`);
