import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HspClient } from '../src/hspClient.js';
import { PaymentAgent, DevMerchantKey } from '../src/paymentAgent.js';
import { ReceivingAgent } from '../src/receivingAgent.js';
import { createMockGateway } from '../src/mockGateway.js';
import { WebhookReceiver } from '../src/webhookReceiver.js';

const root = path => new URL(path, import.meta.url).pathname;
const artifactRoot = root('../demo-artifacts');
const brief = JSON.parse(fs.readFileSync(root('../demo-artifacts/brief.json'), 'utf8'));

function setup() {
  const merchantKey = new DevMerchantKey();
  const gateway = createMockGateway({ appKey: 'ak_p', appSecret: 'sk_p', merchantPublicKey: merchantKey.publicKey, merchantName: 'M' });
  const hsp = new HspClient({ baseUrl: 'https://merchant-qa.hashkeymerchant.com', appKey: 'ak_p', appSecret: 'sk_p', transport: gateway.transport });
  const payer = new PaymentAgent({ merchantName: 'M', hsp, merchantKey, payerAddress: '0xPAYER', network: 'hashkey-testnet', chainId: 133, tokenContract: '0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6' });
  const worker = new ReceivingAgent({ agentId: 'w1', recipient: '0xWORKER' });
  return { gateway, payer, worker };
}

test('PASS flow: real verification -> order awaiting_payer, nothing settled yet', async () => {
  const { gateway, payer, worker } = setup();
  const conditions = worker.presentPaymentConditions({ amountUsd: '10', memo: 'job' });
  const r = await payer.handlePaymentConditions(conditions, brief.requirements, { artifactRoot });
  assert.equal(r.status, 'awaiting_payer');
  assert.equal(r.verification.verdict, 'PASS');
  assert.equal(gateway.payments.get(r.order.payment_request_id).status, 'payment-required');
  assert.match(payer.answer('status?'), /payment-required/);
});

test('full settle cycle through flat webhook with dedupe', async () => {
  const { gateway, payer, worker } = setup();
  const receiver = new WebhookReceiver({ appSecret: 'sk_p', expectationFor: (id) => gateway.paymentExpectation(id) });
  const conditions = worker.presentPaymentConditions({ amountUsd: '10', memo: 'job' });
  const r = await payer.handlePaymentConditions(conditions, brief.requirements, { artifactRoot });
  gateway.submitMockPayerSignature(r.order.payment_request_id, { payerAddress: '0xPAYER', requestId: r.mandate.request_id });
  const hook = gateway.issueWebhook(r.order.payment_request_id);
  const res = receiver.handle({ rawBody: hook.rawBody, header: hook.header });
  assert.equal(res.ok, true);
  payer.noteSettlement({ paymentRequestId: r.order.payment_request_id, status: res.status });
  assert.match(payer.answer('was it paid? status'), /settled/);
});

test('refusal: failing requirement creates no order, no mandate, no payment', async () => {
  const { gateway, payer, worker } = setup();
  const bad = JSON.parse(JSON.stringify(brief.requirements));
  bad[0].check.sha256 = 'deadbeef'.repeat(8);
  const conditions = worker.presentPaymentConditions({ amountUsd: '10', memo: 'job' });
  const r = await payer.handlePaymentConditions(conditions, bad, { artifactRoot });
  assert.equal(r.status, 'verification_failed');
  assert.equal(gateway.orders.size, 0);
  assert.equal(gateway.payments.size, 0);
  assert.match(payer.answer('why refused?'), /refused/);
});
