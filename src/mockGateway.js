import crypto from 'node:crypto';
import { sha256hex, newId } from './mandates.js';
import { verifyMerchantAuthorization } from './es256k.js';

// Mock HSP gateway for development and the demo. NOT a live payment rail: no
// real funds move and settlement is simulated. It DOES enforce the documented
// request contract so integration mistakes show up here instead of against
// the real QA gateway:
//   - HMAC auth over the RAW wire body bytes (no re-canonicalization: a
//     middlebox that re-serializes the JSON breaks the signature, as it
//     should)
//   - request timestamp within +-300s, nonce uniqueness (replay rejected)
//   - ES256K merchant_authorization JWT (issuer, aud, cart_hash, expiry)
//   - duplicate cart_mandate_id -> HTTP 400 code 40001
//   - error codes per docs/en/appendix.md: 10001 invalid params (400),
//     10002 unauthorized (401), 10003 not found (404), 40001 mandate state
//     (400); success envelope always { code: 0, ... } on HTTP 200
// Lifecycle: a created order is 'payment-required'. NOTHING settles until the
// explicit mock payer step (submitMockPayerSignature), which simulates the
// payer signing at the payment_url (EIP-3009/permit2 on-chain) and the
// transaction finalizing. That step is a simulation, not an HSP API.

const MAX_SKEW_SECONDS = 300;

export function createMockGateway({ appKey = 'ak_demo', appSecret = 'sk_demo', merchantPublicKey = null, merchantName = null, nowSeconds = () => Math.floor(Date.now() / 1000) } = {}) {
  const orders = new Map(); // cart_mandate_id -> order record
  const payments = new Map(); // payment_request_id -> payment record
  const seenNonces = new Set();

  const err = (status, code, msg) => ({ ok: false, status, body: JSON.stringify({ code, msg }) });

  function checkAuth(method, path, query, headers, rawBody) {
    const sig = headers['X-Signature'] ?? headers['x-signature'];
    const ts = headers['X-Timestamp'] ?? headers['x-timestamp'];
    const nonce = headers['X-Nonce'] ?? headers['x-nonce'];
    const key = headers['X-App-Key'] ?? headers['x-app-key'];
    if (!sig || !ts || !nonce || key !== appKey) return err(401, 10002, 'missing or invalid auth headers');
    if (!/^\d+$/.test(String(ts)) || Math.abs(nowSeconds() - Number(ts)) > MAX_SKEW_SECONDS) return err(401, 10002, 'timestamp outside tolerance');
    if (seenNonces.has(String(nonce))) return err(401, 10002, 'nonce replay rejected');
    const bodyHash = rawBody ? sha256hex(rawBody) : ''; // RAW wire bytes, exactly as received
    const message = [method, path, query || '', bodyHash, String(ts), String(nonce)].join('\n');
    const expected = crypto.createHmac('sha256', appSecret).update(message).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(sig), 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return err(401, 10002, 'signature mismatch');
    seenNonces.add(String(nonce));
    return null;
  }

  const transport = async ({ method, path, query = '', headers, body }) => {
    const authError = checkAuth(method, path, query, headers || {}, body || '');
    if (authError) return authError;

    if (method === 'POST' && path === '/api/v1/merchant/orders') {
      let parsed;
      try { parsed = JSON.parse(body); } catch { return err(400, 10001, 'invalid JSON body'); }
      const contents = parsed?.cart_mandate?.contents;
      if (!contents?.id || !contents?.payment_request?.details?.id || !contents?.payment_request?.method_data?.[0]?.data) {
        return err(400, 10001, 'invalid cart mandate');
      }
      if (orders.has(contents.id)) return err(400, 40001, 'duplicate cart_mandate_id');
      if (merchantPublicKey) {
        const v = verifyMerchantAuthorization({ publicKey: merchantPublicKey, contents, jwt: parsed.cart_mandate.merchant_authorization, expectedIssuer: merchantName || contents.merchant_name });
        if (!v.ok) return err(401, 10002, `merchant_authorization rejected: ${v.reason}`);
      }
      const flowId = newId('flow');
      const md = contents.payment_request.method_data[0].data;
      const paymentRequestId = contents.payment_request.details.id;
      const usd = contents.payment_request.details.total.amount.value;
      const payment = {
        payment_request_id: paymentRequestId,
        request_id: null, // set by the payer step (ID5)
        cart_mandate_id: contents.id,
        flow_id: flowId,
        payer_address: null,
        to_pay_address: md.pay_to,
        amount: usd, order_amount: usd, product_amount: usd, pay_amount: usd, usd_amount: usd,
        gas_fee: '0', gas_fee_amount: '0', gas_fee_advanced: false, network_fee: '0', service_fee: '0', base_fee: '0',
        token: md.coin,
        token_address: md.contract_address,
        chain: `eip155:${md.chain_id}`,
        network: md.network,
        status: 'payment-required',
        created_at: new Date().toISOString(),
      };
      orders.set(contents.id, { contents, flow_id: flowId });
      payments.set(paymentRequestId, payment);
      return { ok: true, status: 200, body: JSON.stringify({ code: 0, msg: 'success', data: { payment_request_id: paymentRequestId, payment_url: `https://pay.mock/flow/${flowId}`, multi_pay: false } }) };
    }

    if (method === 'GET' && path === '/api/v1/merchant/payments') {
      const params = new URLSearchParams(query);
      const byReq = params.get('payment_request_id');
      const byCart = params.get('cart_mandate_id');
      const byFlow = params.get('flow_id');
      if (byReq) {
        const p = payments.get(byReq);
        return p ? { ok: true, status: 200, body: JSON.stringify({ code: 0, msg: 'success', data: p }) }
                 : err(404, 10003, 'payment not found');
      }
      if (byCart) {
        const order = orders.get(byCart);
        if (!order) return err(404, 10003, 'order not found');
        const list = [payments.get(order.contents.payment_request.details.id)].filter(Boolean);
        return { ok: true, status: 200, body: JSON.stringify({ code: 0, msg: 'success', data: list }) };
      }
      if (byFlow) {
        const p = [...payments.values()].find((x) => x.flow_id === byFlow);
        return p ? { ok: true, status: 200, body: JSON.stringify({ code: 0, msg: 'success', data: p }) }
                 : err(404, 10003, 'payment not found');
      }
      return err(400, 10001, 'exactly one query parameter required');
    }

    return err(404, 10003, 'unknown path');
  };

  // SIMULATION ONLY - not an HSP API. Stands in for: payer opens payment_url,
  // signs with the wallet (EIP-3009 on hashkey-testnet per onboarding.md), the
  // on-chain transaction is included and finalized. requestId is the ID5 from
  // the user-side Payment Mandate.
  const submitMockPayerSignature = (paymentRequestId, { payerAddress, requestId }) => {
    const p = payments.get(paymentRequestId);
    if (!p) throw new Error(`unknown payment_request_id: ${paymentRequestId}`);
    if (p.status !== 'payment-required') throw new Error(`payment not awaiting payer (status: ${p.status})`);
    if (!requestId) throw new Error('requestId (ID5) required');
    p.request_id = requestId;
    p.payer_address = payerAddress;
    p.status = 'payment-finalized';
    p.tx_signature = `0x${crypto.randomBytes(32).toString('hex')} (mock)`;
    p.included_at = new Date().toISOString();
    p.completed_at = p.included_at;
    p.status_reason = 'mock settlement - no real transaction exists';
    return p;
  };

  // Flat webhook payload per docs/en/webhook.md, signed with the t=,v1=
  // envelope over the raw body. Only issuable once finalized.
  const issueWebhook = (paymentRequestId, { now = nowSeconds() } = {}) => {
    const p = payments.get(paymentRequestId);
    if (!p) throw new Error(`unknown payment_request_id: ${paymentRequestId}`);
    if (p.status === 'payment-required') throw new Error('payment not settled yet - no webhook before the payer step');
    const rawBody = JSON.stringify({
      event_type: 'payment',
      payment_request_id: p.payment_request_id,
      request_id: p.request_id,
      cart_mandate_id: p.cart_mandate_id,
      payer_address: p.payer_address,
      to_pay_address: p.to_pay_address,
      amount: p.amount,
      order_amount: p.order_amount,
      product_amount: p.product_amount,
      pay_amount: p.pay_amount,
      usd_amount: p.usd_amount,
      gas_fee: p.gas_fee,
      gas_fee_amount: p.gas_fee_amount,
      gas_fee_advanced: p.gas_fee_advanced,
      network_fee: p.network_fee,
      service_fee: p.service_fee,
      base_fee: p.base_fee,
      token: p.token,
      token_address: p.token_address,
      chain: p.chain,
      network: p.network,
      status: p.status,
      created_at: p.created_at,
      tx_signature: p.tx_signature,
      included_at: p.included_at,
      completed_at: p.completed_at,
      status_reason: p.status_reason,
    });
    const v1 = crypto.createHmac('sha256', appSecret).update(`${now}.${rawBody}`).digest('hex');
    return { rawBody, header: `t=${now},v1=${v1}` };
  };

  // What the receiver should expect for a given payment_request_id.
  const paymentExpectation = (paymentRequestId) => {
    const p = payments.get(paymentRequestId);
    if (!p) return null;
    return {
      payment_request_id: p.payment_request_id,
      cart_mandate_id: p.cart_mandate_id,
      request_id: p.request_id,
      amount: p.amount,
      token: p.token,
      chain: p.chain,
      network: p.network,
    };
  };

  return { transport, issueWebhook, submitMockPayerSignature, paymentExpectation, orders, payments };
}
