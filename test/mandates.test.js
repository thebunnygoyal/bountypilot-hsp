import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, cartHash, buildCartContents, buildPaymentMandate } from '../src/mandates.js';

test('canonicalJson sorts keys recursively and is compact', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
});

test('cartHash is key-order independent', () => {
  const a = buildCartContents({ merchantName: 'M', amountUsd: '5', network: 'hashkey-testnet', chainId: 133, tokenContract: '0xT', payTo: '0xP' });
  const rebuilt = JSON.parse(canonicalJson(a));
  assert.equal(cartHash(a), cartHash(rebuilt));
});

test('payment mandate maps ID4=payment_request_id and fresh request_id (ID5)', () => {
  const contents = buildCartContents({ merchantName: 'M', amountUsd: '5', network: 'hashkey-testnet', chainId: 133, tokenContract: '0xT', payTo: '0xP' });
  const m1 = buildPaymentMandate(contents, { signerAddress: '0xS' });
  const m2 = buildPaymentMandate(contents, { signerAddress: '0xS' });
  assert.equal(m1.payment_mandate_id, contents.payment_request.details.id);
  assert.notEqual(m1.request_id, m2.request_id);
});

test('cart contents require the official network fields', () => {
  assert.throws(() => buildCartContents({ merchantName: 'M', amountUsd: '5' }), /require/);
  const c = buildCartContents({ merchantName: 'M', amountUsd: '5', network: 'hashkey-testnet', chainId: 133, tokenContract: '0xT', payTo: '0xP' });
  assert.equal(c.payment_request.method_data[0].data.network, 'hashkey-testnet');
  assert.equal(c.payment_request.method_data[0].data.chain_id, 133);
});
