import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMerchantKeypair, signMerchantAuthorization, verifyMerchantAuthorization } from '../src/es256k.js';
import { buildCartContents } from '../src/mandates.js';

const keypair = generateMerchantKeypair();
const contents = buildCartContents({ merchantName: 'M', amountUsd: '5', network: 'hashkey-testnet', chainId: 133, tokenContract: '0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6', payTo: '0xP' });
const sign = (over = {}) => signMerchantAuthorization({ privateKey: keypair.privateKey, merchantName: 'M', contents, ...over });

test('valid JWT verifies with issuer check', () => {
  const jwt = sign();
  const v = verifyMerchantAuthorization({ publicKey: keypair.publicKey, contents, jwt, expectedIssuer: 'M' });
  assert.equal(v.ok, true);
  assert.equal(v.claims.aud, 'HashkeyMerchant');
});

test('tampered contents (cart_hash mismatch) rejected', () => {
  const jwt = sign();
  const other = buildCartContents({ merchantName: 'M', amountUsd: '999', network: 'hashkey-testnet', chainId: 133, tokenContract: '0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6', payTo: '0xP' });
  const v = verifyMerchantAuthorization({ publicKey: keypair.publicKey, contents: other, jwt, expectedIssuer: 'M' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /cart_hash/);
});

test('wrong issuer rejected', () => {
  const jwt = sign();
  const v = verifyMerchantAuthorization({ publicKey: keypair.publicKey, contents, jwt, expectedIssuer: 'Someone Else' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /iss\/sub/);
});

test('malformed tokens return ok:false, never throw', () => {
  for (const jwt of ['', 'a.b', 'a.b.c.d', 'x.!!!not-base64!!!.y', 'a.e30.c']) {
    const v = verifyMerchantAuthorization({ publicKey: keypair.publicKey, contents, jwt, expectedIssuer: 'M' });
    assert.equal(v.ok, false, `should reject: ${jwt}`);
  }
});

test('expired token rejected', () => {
  const jwt = sign({ ttlSeconds: -10 });
  const v = verifyMerchantAuthorization({ publicKey: keypair.publicKey, contents, jwt, expectedIssuer: 'M' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /expired/);
});

test('wrong key rejected', () => {
  const jwt = sign();
  const other = generateMerchantKeypair();
  const v = verifyMerchantAuthorization({ publicKey: other.publicKey, contents, jwt, expectedIssuer: 'M' });
  assert.equal(v.ok, false);
});
