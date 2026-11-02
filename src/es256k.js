import crypto from 'node:crypto';
import { cartHash } from './mandates.js';

// ES256K JWT signing for cart_mandate.merchant_authorization, zero
// dependencies: node:crypto supports secp256k1 with ieee-p1363 (raw R||S)
// signature encoding, which is exactly the JWS format.

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function generateMerchantKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  return { privateKey, publicKey };
}

export function signMerchantAuthorization({ privateKey, merchantName, contents, ttlSeconds = 3600 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256K', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: merchantName,
    sub: merchantName,
    aud: 'HashkeyMerchant',
    iat: now,
    exp: now + ttlSeconds,
    jti: `JWT-${now}-${crypto.randomBytes(6).toString('hex')}`,
    cart_hash: cartHash(contents),
  }));
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}

// Verify a merchant_authorization JWT against the merchant public key, the
// expected issuer, and the cart contents it claims to authorize. Any
// malformed input (bad segment count, bad base64, non-JSON payload) returns
// ok:false - it never throws.
export function verifyMerchantAuthorization({ publicKey, contents, jwt, expectedIssuer }) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) return { ok: false, reason: 'not a compact JWT' };
  const [header, payload, signature] = parts;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed payload' };
  }
  if (!claims || typeof claims !== 'object') return { ok: false, reason: 'malformed payload' };
  if (expectedIssuer && (claims.iss !== expectedIssuer || claims.sub !== expectedIssuer)) {
    return { ok: false, reason: 'iss/sub mismatch' };
  }
  if (claims.aud !== 'HashkeyMerchant') return { ok: false, reason: 'aud mismatch' };
  if (claims.cart_hash !== cartHash(contents)) return { ok: false, reason: 'cart_hash mismatch' };
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && claims.exp < now) return { ok: false, reason: 'expired' };
  let sig;
  try {
    sig = Buffer.from(signature, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed signature' };
  }
  let valid = false;
  try {
    valid = crypto.verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return { ok: false, reason: 'verification error' };
  }
  return valid ? { ok: true, claims } : { ok: false, reason: 'bad signature' };
}
