#!/usr/bin/env node
/**
 * Local preview server. Serves the app and emulates just enough of the GitHub
 * contents API (GET/PUT a JSON file, with sha-based conflict detection) that
 * the real app code runs unmodified against files in ./data.
 *
 *   npm run preview   ->   http://localhost:8787
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8787;

const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// Git's blob hash, so the sha the app sends back is the real thing.
const blobSha = (buf) =>
  crypto.createHash('sha1').update(`blob ${buf.length}\0`).end().digest('hex');

const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  };

  // --- emulated GitHub contents API ---
  const match = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
  if (match) {
    const file = path.join(ROOT, decodeURIComponent(match[1]));
    if (!file.startsWith(path.join(ROOT, 'data'))) return send(403, '{"message":"forbidden"}');

    if (req.method === 'GET') {
      if (!fs.existsSync(file)) return send(404, '{"message":"Not Found"}');
      const buf = fs.readFileSync(file);
      return send(200, JSON.stringify({ content: buf.toString('base64'), sha: blobSha(buf) }));
    }

    if (req.method === 'PUT') {
      const body = JSON.parse(await readBody(req));
      const current = fs.existsSync(file) ? fs.readFileSync(file) : null;
      if (current && body.sha !== blobSha(current)) {
        return send(409, '{"message":"sha mismatch"}');
      }
      const next = Buffer.from(body.content, 'base64');
      fs.writeFileSync(file, next);
      console.log(`  wrote ${match[1]} — ${body.message}`);
      return send(200, JSON.stringify({ content: { sha: blobSha(next) } }));
    }
    return send(405, '{"message":"method not allowed"}');
  }

  // --- static files ---
  let rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  // Preview runs against the local emulator, not the real GitHub.
  if (rel === 'config.js' && fs.existsSync(path.join(ROOT, 'config.local.js'))) {
    rel = 'config.local.js';
  }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(404, 'Not found', 'text/plain');
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(fs.readFileSync(file));
});

server.listen(PORT, () => console.log(`Choreloop preview: http://localhost:${PORT}`));
