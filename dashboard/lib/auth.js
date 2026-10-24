// lib/auth.js — password hashing and random tokens (Node built-ins only).
import crypto from 'node:crypto';

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randHex = (n) => crypto.randomBytes(n).toString('hex');

const N = 16384;
const R = 8;
const P = 1;

function scrypt(password, salt, n, r, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Returns "scrypt$N$r$p$salt$hash" (base64 parts). */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

let dummy;
/** Verify against a throwaway hash so unknown emails take as long as wrong passwords. */
export async function burnVerify(password) {
  dummy ||= await hashPassword('not-a-real-password');
  await verifyPassword(password, dummy);
}
