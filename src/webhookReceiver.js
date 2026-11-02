import { HspClient } from './hspClient.js';

// Settlement webhook receiver: verifies the t=,v1= HMAC envelope, then
// applies business validation against the order we created and idempotency
// on request_id. In this project it runs in-process (no public endpoint is
// exposed); production wires handle() to an HTTPS route answering 2xx within
// 10s per docs/en/webhook.md.

const KNOWN_STATUSES = new Set(['payment-included', 'payment-safe', 'payment-finalized', 'payment-failed']);

export class WebhookReceiver {
  // expectationFor: (payment_request_id) => ({cart_mandate_id, request_id, amount, token, chain, network}) | null
  constructor({ appSecret, expectationFor }) {
    this.appSecret = appSecret;
    this.expectationFor = expectationFor;
    this.seenRequestIds = new Set();
    this.payments = new Map(); // payment_request_id -> latest accepted status
  }

  handle({ rawBody, header, nowSeconds }) {
    const sig = HspClient.verifyWebhookSignature({ appSecret: this.appSecret, rawBody, header, ...(nowSeconds ? { nowSeconds } : {}) });
    if (!sig.ok) return { ok: false, reason: `signature: ${sig.reason}` };
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { ok: false, reason: 'malformed payload JSON' };
    }
    if (payload.event_type !== 'payment') return { ok: false, reason: 'unexpected event_type' };
    if (!KNOWN_STATUSES.has(payload.status)) return { ok: false, reason: `unknown status: ${payload.status}` };
    const expected = this.expectationFor(payload.payment_request_id);
    if (!expected) return { ok: false, reason: 'unknown payment_request_id' };
    if (expected.request_id && payload.request_id !== expected.request_id) return { ok: false, reason: 'request_id mismatch' };
    const mismatches = ['cart_mandate_id', 'token', 'chain', 'network'].filter((f) => expected[f] != null && payload[f] !== expected[f]);
    // Every amount field present in the payload must equal the order amount.
    if (expected.amount != null) {
      for (const f of ['amount', 'pay_amount', 'order_amount']) {
        if (payload[f] != null && payload[f] !== expected.amount) mismatches.push(f);
      }
    }
    if (mismatches.length) return { ok: false, reason: `field mismatch: ${mismatches.join(', ')}` };
    if (this.seenRequestIds.has(payload.request_id)) {
      return { ok: true, duplicate: true, status: payload.status, payment_request_id: payload.payment_request_id };
    }
    this.seenRequestIds.add(payload.request_id);
    this.payments.set(payload.payment_request_id, payload.status);
    return { ok: true, duplicate: false, status: payload.status, payment_request_id: payload.payment_request_id };
  }
}
