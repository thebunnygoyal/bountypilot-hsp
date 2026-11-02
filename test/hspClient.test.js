import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { HspClient } from '../src/hspClient.js';
import { createMockGateway } from '../src/mockGateway.js';
import { canonicalJson, sha256hex, buildCartContents } from '../src/mandates.js';
import { generateMerchantKeypair, signMerchantAuthorization } from '../src/es256k.js';

const keypair = generateMerchantKeypair();
const MERCHANT = 'Test Merchant';
const NETWORK = 'hashkey-testnet';
const QA_USDC = '0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6';

function setup(extra = {}) {
  const gateway = createMockGateway({ appKey: 'ak_t', appSecret: 'sk_t', merchantPublicKey: keypair.publicKey, merchantName: MERCHANT, ...extra });
  const client = new HspClient({ baseUrl: 'https://merchant-qa.hashkeymerchant.com', appKey: 'ak_t', appSecret: 'sk_t', transport: gateway.transport });
  return { gateway, client };
}

function makeCart() {
  const contents = buildCartContents({ merchantName: MERCHANT, amountUsd: '10', network: NETWORK, chainId: 133, tokenContract: QA_USDC, payTo: '0xPAYEE' });
  return { contents, merchant_authorization: signMerchantAuthorization({ privateKey: keypair.privateKey, merchantName: MERCHANT, contents }) };
}

test('client signs and sends the SAME canonical wire bytes', async () => {
  const { client } = setup();
  let captured;
  client.transport = async (req) => { captured = req; return { ok: true, status: 200, body: JSON.stringify({ code: 0, msg: 'ok', data: {} }) }; };
  const cart = makeCart();
  await client.createOrder(cart);
  const expectedWire = canonicalJson({ cart_mandate: cart });
  assert.equal(captured.body, expectedWire, 'wire body must be the canonical bytes');
  const ts = captured.headers['X-Timestamp'];
  const nonce = captured.headers['X-Nonce'];
  const message = ['POST', '/api/v1/merchant/orders', '', sha256hex(captured.body), ts, nonce].join('\n');
  const expectedSig = crypto.createHmac('sha256', 'sk_t').update(message).digest('hex');
  assert.equal(captured.headers['X-Signature'], expectedSig, 'signature must be over the raw wire hash');
});

test('gateway hashes raw wire bytes: any byte-level change breaks auth', async () => {
  const { gateway, client } = setup();
  const cart = makeCart();
  const { wire, headers } = client.signRequest('POST', '/api/v1/merchant/orders', '', { cart_mandate: cart });
  const tampered = await gateway.transport({ method: 'POST', path: '/api/v1/merchant/orders', query: '', headers, body: wire + ' ' });
  assert.equal(tampered.status, 401);
  assert.equal(JSON.parse(tampered.body).code, 10002);
});

test('order lifecycle: created as payment-required, settles only after mock payer step', async () => {
  const { gateway, client } = setup();
  const order = await client.createOrder(makeCart());
  const prid = order.data.payment_request_id;
  let p = await client.getPayments({ paymentRequestId: prid });
  assert.equal(p.data.status, 'payment-required');
  assert.throws(() => gateway.issueWebhook(prid), /not settled/);
  gateway.submitMockPayerSignature(prid, { payerAddress: '0xPAYER', requestId: 'req_test_1' });
  p = await client.getPayments({ paymentRequestId: prid });
  assert.equal(p.data.status, 'payment-finalized');
  assert.equal(p.data.request_id, 'req_test_1');
  assert.doesNotThrow(() => gateway.issueWebhook(prid));
});

test('duplicate cart_mandate_id -> HTTP 400 code 40001', async () => {
  const { client } = setup();
  const cart = makeCart();
  await client.createOrder(cart);
  await assert.rejects(() => client.createOrder(cart), /code=40001 http=400/);
});

test('bad auth -> HTTP 401 code 10002', async () => {
  const { gateway } = setup();
  const res = await gateway.transport({ method: 'GET', path: '/api/v1/merchant/payments', query: 'payment_request_id=x', headers: {}, body: '' });
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).code, 10002);
});

test('not found -> HTTP 404 code 10003', async () => {
  const { client } = setup();
  await assert.rejects(() => client.getPayments({ paymentRequestId: 'preq_nope' }), /code=10003 http=404/);
});

test('client throws when HTTP 200 but body code !== 0', async () => {
  const client = new HspClient({
    baseUrl: 'https://x', appKey: 'a', appSecret: 's',
    transport: async () => ({ ok: true, status: 200, body: JSON.stringify({ code: 40001, msg: 'reused cart_mandate_id' }) }),
  });
  await assert.rejects(() => client.createOrder(makeCart()), /40001/);
});

test('request timestamp outside +-300s is rejected both directions', async () => {
  const now = 1_800_000_000;
  const { gateway, client } = setup({ nowSeconds: () => now });
  const cart = makeCart();
  for (const ts of [now - 301, now + 301]) {
    const { wire, headers } = client.signRequest('POST', '/api/v1/merchant/orders', '', { cart_mandate: cart });
    headers['X-Timestamp'] = String(ts);
    const bodyHash = sha256hex(wire);
    const message = ['POST', '/api/v1/merchant/orders', '', bodyHash, String(ts), headers['X-Nonce']].join('\n');
    headers['X-Signature'] = crypto.createHmac('sha256', 'sk_t').update(message).digest('hex');
    const res = await gateway.transport({ method: 'POST', path: '/api/v1/merchant/orders', query: '', headers, body: wire });
    assert.equal(res.status, 401, `ts ${ts} should be rejected`);
    assert.equal(JSON.parse(res.body).code, 10002);
  }
});

test('nonce replay is rejected', async () => {
  const { gateway, client } = setup();
  const cart = makeCart();
  const { wire, headers } = client.signRequest('POST', '/api/v1/merchant/orders', '', { cart_mandate: cart });
  const first = await gateway.transport({ method: 'POST', path: '/api/v1/merchant/orders', query: '', headers, body: wire });
  assert.equal(first.status, 200);
  const replay = await gateway.transport({ method: 'POST', path: '/api/v1/merchant/orders', query: '', headers, body: wire });
  assert.equal(replay.status, 401);
  assert.match(JSON.parse(replay.body).msg, /nonce replay/);
});

test('getPayments enforces exactly one query parameter', async () => {
  const { client } = setup();
  await assert.rejects(() => client.getPayments({}), /exactly one/);
  await assert.rejects(() => client.getPayments({ cartMandateId: 'a', flowId: 'b' }), /exactly one/);
});
