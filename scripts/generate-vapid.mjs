#!/usr/bin/env node
// Generates a VAPID keypair for Web Push. No dependencies — uses Node's built-in crypto.
import { generateKeyPairSync } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

const pubJwk = publicKey.export({ format: 'jwk' });
const privJwk = privateKey.export({ format: 'jwk' });

// Raw uncompressed public point (65 bytes: 0x04 || X || Y) and raw private scalar (32 bytes)
const pub = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(pubJwk.x, 'base64url'),
  Buffer.from(pubJwk.y, 'base64url'),
]);
const priv = Buffer.from(privJwk.d, 'base64url');

console.log('VAPID_PUBLIC_KEY  = ' + b64url(pub));
console.log('VAPID_PRIVATE_KEY = ' + b64url(priv));
