import crypto from 'node:crypto';
import { canonicalJson, sha256hex } from './mandates.js';

// HSP gateway client implementing the documented Merchant API auth
// (docs/en/authentication.md):
//   headers: X-App-Key, X-Signature, X-Timestamp (unix seconds), X-Nonce
//   message: METHOD\nPATH\nQUERY\nbodyHash\ntimestamp\nnonce
//   bodyHash: sha256 hex of the RAW request body bytes, '' for GET
//   signature: hex HMAC-SHA256(app_secret, message)
// The body is serialized to Canonical JSON ONCE and those exact bytes are both
// signed and sent. Never sign canonical bytes but send JSON.stringify output.
// Base URLs (docs/en/api-reference.md):
//   QA: https://merchant-qa.hashkeymerchant.com
//   Staging: https://merchant-stg.hashkeymerchant.com
//   Production: https://hsp.hashkey.com
// Transport is injectable; tests and the demo use the mock gateway.

const MAX_SKEW_SECONDS = 300;

export class HspClient {
  constructor({ baseUrl, appKey = '', appSecret = '', transport }) {
    if (!baseUrl) throw new Error('baseUrl required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.appKey = appKey;
    this.appSecret = appSecret;
    this.transport = transport || defaultTransport;
  }

  // Returns the auth headers AND the exact wire body bytes that were signed.
  signRequest(method, path, query, bodyObj) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const wire = bodyObj ? canonicalJson(bodyObj) : '';
    const bodyHash = wire ? sha256hex(wire) : '';
    const message = [method, path, query || '', bodyHash, timestamp, nonce].join('\n');
    const signature = crypto.createHmac('sha256', this.appSecret).update(message).digest('hex');
    return {
      wire,
      headers: {
        'content-type': 'application/json',
        'X-App-Key': this.appKey,
        'X-Signature': signature,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
      },
    };
  }

  async request(method, path, query, bodyObj) {
    const { wire, headers } = this.signRequest(method, path, query, bodyObj);
    const res = await this.transport({ method, url: this.baseUrl + path + (query ? `?${query}` : ''), path, query, headers, body: wire });
    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new Error(`HSP returned non-JSON response (HTTP ${res.status})`);
    }
    // The API signals errors in the body code even on HTTP 200 (appendix.md).
    if (!res.ok || parsed.code !== 0) {
      throw new Error(`HSP error code=${parsed.code ?? 'n/a'} http=${res.status}: ${parsed.msg ?? 'unknown'}`);
    }
    return parsed;
  }

  async createOrder(cartMandate, { redirectUrl } = {}) {
    const bodyObj = redirectUrl ? { cart_mandate: cartMandate, redirect_url: redirectUrl } : { cart_mandate: cartMandate };
    const res = await this.request('POST', '/api/v1/merchant/orders', '', bodyObj);
    return res; // { code:0, msg, data: { payment_request_id, payment_url, multi_pay } }
  }

  async getPayments({ cartMandateId, paymentRequestId, flowId }) {
    const provided = [cartMandateId, paymentRequestId, flowId].filter(Boolean).length;
    if (provided !== 1) throw new Error('exactly one query parameter allowed');
    const key = cartMandateId ? 'cart_mandate_id' : paymentRequestId ? 'payment_request_id' : 'flow_id';
    const value = cartMandateId || paymentRequestId || flowId;
    const query = `${key}=${encodeURIComponent(value)}`;
    return this.request('GET', '/api/v1/merchant/payments', query, null);
  }

  // Webhook verification per docs/en/webhook.md:
  //   header X-Signature: t=<unix>,v1=<hmac_hex>
  //   message = t + "." + rawBody; signature = hex HMAC-SHA256(app_secret, message)
  //   reject when |now - t| > 300s (both directions)
  static verifyWebhookSignature({ appSecret, rawBody, header, nowSeconds = Math.floor(Date.now() / 1000) }) {
    const match = /t=(\d+),v1=([0-9a-f]{64})/.exec(String(header || ''));
    if (!match) return { ok: false, reason: 'malformed X-Signature header' };
    const [, t, v1] = match;
    if (Math.abs(nowSeconds - Number(t)) > MAX_SKEW_SECONDS) return { ok: false, reason: 'timestamp outside 300s window' };
    const expected = crypto.createHmac('sha256', appSecret).update(`${t}.${rawBody}`).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(v1, 'utf8');
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    return ok ? { ok: true, timestamp: Number(t) } : { ok: false, reason: 'signature mismatch' };
  }
}

async function defaultTransport({ method, url, headers, body }) {
  const res = await fetch(url, { method, headers, body: method === 'GET' ? undefined : body });
  return { ok: res.ok, status: res.status, body: await res.text() };
}
