import fs from 'node:fs';
import { HspClient } from './src/hspClient.js';
import { PaymentAgent, DevMerchantKey } from './src/paymentAgent.js';
import { ReceivingAgent } from './src/receivingAgent.js';
import { createMockGateway } from './src/mockGateway.js';
import { WebhookReceiver } from './src/webhookReceiver.js';

// Full A2A settlement demo on the MOCK gateway with the REAL documented
// contract: canonical wire bytes signed and sent identically, HMAC request
// auth with timestamp+nonce checks, ES256K merchant_authorization JWT,
// payment-required -> payer step -> settlement webhook lifecycle, flat
// spec-shaped webhook payload validated against the order. NO LIVE PAYMENTS.
// The payer step (submitMockPayerSignature) simulates the EIP-3009 wallet
// signature and on-chain finalization; it is not an HSP API.

const NETWORK = 'hashkey-testnet'; // docs/en/onboarding.md
const CHAIN_ID = 133;
const QA_USDC = '0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6'; // official QA USDC, onboarding.md

const merchantKey = new DevMerchantKey();
const gateway = createMockGateway({ appKey: 'ak_demo', appSecret: 'sk_demo', merchantPublicKey: merchantKey.publicKey, merchantName: 'BountyPilot Demo Merchant' });
const hsp = new HspClient({ baseUrl: 'https://merchant-qa.hashkeymerchant.com', appKey: 'ak_demo', appSecret: 'sk_demo', transport: gateway.transport });
const receiver = new WebhookReceiver({ appSecret: 'sk_demo', expectationFor: (id) => gateway.paymentExpectation(id) });

const worker = new ReceivingAgent({ agentId: 'bounty-worker-01', recipient: '0xW0RKER00000000000000000000000000000001' });
const payer = new PaymentAgent({
  merchantName: 'BountyPilot Demo Merchant',
  hsp,
  merchantKey,
  payerAddress: '0xPAYER0000000000000000000000000000000002',
  network: NETWORK,
  chainId: CHAIN_ID,
  tokenContract: QA_USDC,
});

const artifactRoot = new URL('./demo-artifacts', import.meta.url).pathname;
const brief = JSON.parse(fs.readFileSync(new URL('./demo-artifacts/brief.json', import.meta.url), 'utf8'));

console.log('1) Worker finishes the bounty work and presents payment conditions');
const conditions = worker.presentPaymentConditions({ amountUsd: '25', memo: 'Bounty: HSK Track 2 demo article' });
console.log('   ', conditions);

console.log('2) Paying agent verifies the work ITSELF (hash check + real test run in confined dir)');
const result = await payer.handlePaymentConditions(conditions, brief.requirements, { artifactRoot });
console.log('   verdict:', result.verification.verdict);
for (const r of result.verification.results) console.log(`     ${r.requirement.id}: ${r.status} - ${r.reason}`);
console.log('   cart_mandate_id:', result.cartMandate.contents.id);
console.log('   merchant_authorization (ES256K JWT):', result.cartMandate.merchant_authorization.slice(0, 60) + '...');
console.log('   order:', result.order);
console.log('   status now:', result.status, '(order is payment-required; nothing has settled)');

console.log('3) MOCK payer step: simulates the EIP-3009 wallet signature at payment_url (not an HSP API)');
gateway.submitMockPayerSignature(result.order.payment_request_id, { payerAddress: payer.payerAddress, requestId: result.mandate.request_id });
console.log('   payment finalized by mock payer, request_id (ID5):', result.mandate.request_id);

console.log('4) Settlement webhook arrives (flat spec payload); receiver verifies signature + fields + dedupes');
const hook = gateway.issueWebhook(result.order.payment_request_id);
const first = receiver.handle({ rawBody: hook.rawBody, header: hook.header });
console.log('   first delivery:', JSON.stringify(first));
const replay = receiver.handle({ rawBody: hook.rawBody, header: hook.header });
console.log('   replayed delivery:', JSON.stringify(replay), '(idempotent)');
payer.noteSettlement({ paymentRequestId: result.order.payment_request_id, status: first.status });

console.log('5) NL interface');
console.log('   Q: what is the payment status?');
console.log('   A:', payer.answer('what is the payment status?'));

console.log('6) Gate check: tampered brief expectation -> real verifier fails -> nothing is created');
const tampered = JSON.parse(JSON.stringify(brief.requirements));
tampered[0].check.sha256 = 'deadbeef'.repeat(8);
const bad = await payer.handlePaymentConditions(conditions, tampered, { artifactRoot });
console.log('   status:', bad.status, '| gateway orders:', gateway.orders.size, '(refusal created nothing)');
console.log('   A:', payer.answer('why was it refused?'));
