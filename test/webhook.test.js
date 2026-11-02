import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { HspClient } from '../src/hspClient.js';
import { createMockGateway } from '../src/mockGateway.js';
import { WebhookReceiver } from '../src/webhookReceiver.js';
import { buildCartContents } from '../src/mandates.js';
import { generateMerchantKeypair, signMerchantAuthorization } from '../src/es256k.js';

const keypair = generateMerchantKeypair();
const QA_USDC = '0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6';

async function settledPayment() {
  const gateway = createMockGateway({ appKey: 'ak_w', appSecret: 'sk_w', merchantPublicKey: keypair.publicKey, merchantName: 'M' });
  const client = new HspClient({ baseUrl: 'https://merchant-qa.hashkeymerchant.com', appKey: 'ak_w', appSecret: 'sk_w', transport: gateway.transport });
  const contents = buildCartContents({ merchantName: 'M', amountUsd: '10', network: 'hashkey-testnet', chainId: 133, tokenContract: QA_USDC, payTo: '0xPAYEE' });
  const jwt = signMerchantAuthorization({ privateKey: keypair.privateKey, merchantName: 'M', contents });
  const order = await client.createOrder({ contents, merchant_authorization: jwt });
  const prid = order.data.payment_request_id;
  gateway.submitMockPayerSignature(prid, { payerAddress: '0xPAYER', requestId: 'req_wh_1' });
  const receiver = new WebhookReceiver({ appSecret: 'sk_w', expectationFor: (id) => gateway.paymentExpectation(id) });
  return { gateway, receiver, prid };
}

test('valid flat webhook accepted; replay deduped by request_id', async () => {
  const { gateway, receiver, prid } = await settledPayment();
  const hook = gateway.issueWebhook(prid);
  const payload = JSON.parse(hook.rawBody);
  for (const f of ['event_type', 'payment_request_id', 'request_id', 'cart_mandate_id', 'status', 'amount', 'order_amount', 'pay_amount', 'usd_amount', 'token', 'token_address', 'chain', 'network', 'created_at', 'tx_signature']) {
    assert.ok(f in payload, `flat payload missing ${f}`);
  }
  assert.equal(payload.event_type, 'payment');
  assert.equal(payload.chain, 'eip155:133');
  assert.equal(payload.network, 'hashkey-testnet');
  const first = receiver.handle({ rawBody: hook.rawBody, header: hook.header });
  assert.deepEqual({ ok: first.ok, duplicate: first.duplicate, status: first.status }, { ok: true, duplicate: false, status: 'payment-finalized' });
  const replay = receiver.handle({ rawBody: hook.rawBody, header: hook.header });
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
});

test('field mismatch against the order is rejected', async () => {
  const { gateway, receiver, prid } = await settledPayment();
  const hook = gateway.issueWebhook(prid);
  const tampered = JSON.parse(hook.rawBody);
  tampered.amount = '9999.99';
  const rawBody = JSON.stringify(tampered);
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', 'sk_w').update(`${t}.${rawBody}`).digest('hex');
  const res = receiver.handle({ rawBody, header: `t=${t},v1=${v1}` });
  assert.equal(res.ok, false);
  assert.match(res.reason, /mismatch/);
});

test('unknown payment_request_id rejected', async () => {
  const { receiver } = await settledPayment();
  const t = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify({ event_type: 'payment', payment_request_id: 'preq_unknown', request_id: 'req_x', status: 'payment-finalized', amount: '1' });
  const v1 = crypto.createHmac('sha256', 'sk_w').update(`${t}.${rawBody}`).digest('hex');
  const res = receiver.handle({ rawBody, header: `t=${t},v1=${v1}` });
  assert.equal(res.ok, false);
  assert.match(res.reason, /unknown payment_request_id/);
});

test('bad signature and skew beyond 300s rejected', async () => {
  const { gateway, receiver, prid } = await settledPayment();
  const hook = gateway.issueWebhook(prid);
  const badSig = receiver.handle({ rawBody: hook.rawBody, header: hook.header.replace(/v1=[0-9a-f]{2}/, 'v1=00') });
  assert.equal(badSig.ok, false);
  const now = Math.floor(Date.now() / 1000);
  const t = now + 301;
  const v1 = crypto.createHmac('sha256', 'sk_w').update(`${t}.${hook.rawBody}`).digest('hex');
  const future = receiver.handle({ rawBody: hook.rawBody, header: `t=${t},v1=${v1}` });
  assert.equal(future.ok, false);
  assert.match(future.reason, /300s/);
  const past = now - 301;
  const v1b = crypto.createHmac('sha256', 'sk_w').update(`${past}.${hook.rawBody}`).digest('hex');
  assert.equal(receiver.handle({ rawBody: hook.rawBody, header: `t=${past},v1=${v1b}` }).ok, false);
});
