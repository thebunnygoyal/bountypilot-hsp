import crypto from 'node:crypto';
import { canonicalJson, sha256hex } from '../mandates.js';

// In-process mock of the official HSP Agentic Payment MCP server
// (https://mcp-qa.hashkeymerchant.com/), implementing the 8 documented tools
// with the guide's exact semantics (revision 2026-10-30):
//   get_chain_config, create_order, get_order, prepare_payment,
//   finalize_payment, estimate_fee, submit_payment, query_payment
// NO live payments, no funds, no network. Quote validity, error code 30043,
// gas_fee_advanced handling, status lifecycle and team attribution all follow
// the guide so the orchestrator is tested against the documented contract.

const TESTNET = {
  network: 'hashkey-testnet',
  chain_id: 133,
  tokens: [
    { symbol: 'USDC', name: 'USD Coin', address: '0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6', decimals: 6, payment_protocol: 'eip3009' },
  ],
};

const POLL_STATES = ['payment-submitted', 'payment-verified', 'payment-processing', 'payment-included', 'payment-safe', 'payment-finalized'];

export class MockHspMcpServer {
  constructor({ now = () => Date.now(), advancePerQuery = 1, gasFeeAdvanced = true, alwaysTimeout = false } = {}) {
    this.now = now;
    this.advancePerQuery = advancePerQuery;
    this.gasFeeAdvanced = gasFeeAdvanced;
    this.alwaysTimeout = alwaysTimeout; // keep returning payment-timeout (recoverable)
    this.orders = new Map();
    this.calls = [];
  }

  listTools() {
    return ['get_chain_config', 'create_order', 'get_order', 'prepare_payment', 'finalize_payment', 'estimate_fee', 'submit_payment', 'query_payment'];
  }

  // JSON-RPC-ish entry used by both the in-process transport and tests.
  handle(method, params) {
    if (method === 'initialize') return { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock-hsp', version: '0.3.0' } };
    if (method === 'tools/list') return { tools: this.listTools().map((name) => ({ name, description: `mock ${name}`, inputSchema: { type: 'object' } })) };
    if (method === 'tools/call') {
      const { name, arguments: args } = params;
      this.calls.push({ name, args: structuredClone(args ?? {}) });
      const out = this.callTool(name, args ?? {});
      if (out?.error) return { isError: true, content: [{ type: 'text', text: JSON.stringify(out.error) }] };
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    }
    throw new Error(`unknown method ${method}`);
  }

  callTool(name, args) {
    const fn = {
      get_chain_config: () => ({ networks: [structuredClone(TESTNET)] }),
      create_order: () => this.#createOrder(args),
      get_order: () => this.#getOrder(args),
      prepare_payment: () => this.#preparePayment(args),
      finalize_payment: () => this.#finalizePayment(args),
      estimate_fee: () => ({ gas_fee: '21000', gas_fee_usd: '0.01' }),
      submit_payment: () => this.#submitPayment(args),
      query_payment: () => this.#queryPayment(args),
    }[name];
    if (!fn) return { error: { code: 10001, message: `unknown tool ${name}` } };
    return fn();
  }

  #createOrder({ merchant_name, pay_to, cart_mandate }) {
    if (!merchant_name || !pay_to || !cart_mandate) return { error: { code: 10001, message: 'merchant_name, pay_to, cart_mandate required' } };
    if (!/^0x[0-9a-fA-F]{40}$/.test(pay_to)) return { error: { code: 10001, message: 'pay_to must be a 42-char 0x address' } };
    const c = cart_mandate.contents;
    if (!c?.id || !c?.cart_expiry || Number.isNaN(Date.parse(c.cart_expiry))) return { error: { code: 10001, message: 'cart contents.id and RFC3339 cart_expiry required' } };
    const md = c?.payment_request?.method_data?.[0];
    if (md?.supported_methods !== 'https://www.x402.org/' || md?.data?.x402Version !== 2) return { error: { code: 10001, message: 'method_data must be x402 v2' } };
    const total = c?.payment_request?.details?.total?.amount;
    if (total?.currency !== 'USD' || !(Number(total?.value) > 0)) return { error: { code: 10001, message: 'USD total required' } };
    const flow_id = `flow_${crypto.randomUUID()}`;
    const payment_request_id = c.payment_request.details.id;
    // Server overrides each method_data item's pay_to with the supplied pay_to.
    const overridden = structuredClone(cart_mandate);
    for (const item of overridden.contents.payment_request.method_data) item.data.pay_to = pay_to;
    this.orders.set(flow_id, {
      flow_id, payment_request_id, merchant_name, pay_to,
      cart_mandate: overridden, amountUsd: total.value,
      state: 'created', stage: -1, tx_signature: '', status_reason: '',
    });
    return { flow_id, payment_request_id, payment_url: `https://pay-qa.mock/flow/${flow_id}` };
  }

  #getOrder({ flow_id }) {
    const o = this.orders.get(flow_id);
    if (!o) return { error: { code: 10003, message: 'order not found' } };
    return { flow_id: o.flow_id, payment_request_id: o.payment_request_id, merchant_name: o.merchant_name, pay_to: o.pay_to, amount_usd: o.amountUsd, gas_fee_advanced: this.gasFeeAdvanced, state: o.state };
  }

  #preparePayment({ flow_id, payer, protocol }) {
    const o = this.orders.get(flow_id);
    if (!o) return { error: { code: 10003, message: 'order not found' } };
    if (!/^0x[0-9a-fA-F]{40}$/.test(payer ?? '')) return { error: { code: 10001, message: 'payer must be a 42-char 0x address' } };
    const token = TESTNET.tokens[0];
    if (protocol !== token.payment_protocol) return { error: { code: 10001, message: `protocol must be ${token.payment_protocol} for ${token.symbol}` } };
    const usdRaw = BigInt(Math.round(Number(o.amountUsd) * 10 ** token.decimals));
    const gasRaw = this.gasFeeAdvanced ? 0n : 21000n * 500n; // payer bears fee when not advanced
    const token_total_raw = (usdRaw + gasRaw).toString();
    const quoteMs = 5 * 60 * 1000;
    const quoteExpires = this.now() + quoteMs;
    o.quote = { token_total_raw, quote_expires_at: new Date(quoteExpires).toISOString(), expiresMs: quoteExpires, payer, attempts: (o.quote?.attempts ?? 0) + 1 };
    const eip712 = {
      domain: { name: 'USD Coin', version: '2', chainId: TESTNET.chain_id, verifyingContract: token.address },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
        ],
        TransferWithAuthorization: [
          { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: payer, to: o.pay_to, value: token_total_raw,
        validAfter: '0', validBefore: String(Math.floor(quoteExpires / 1000)),
        nonce: '0x' + crypto.randomBytes(32).toString('hex'),
      },
    };
    o.state = 'prepared';
    return {
      eip712, cart_hash: sha256hex(canonicalJson(o.cart_mandate.contents)),
      token_total_raw, quote_expires_at: o.quote.quote_expires_at,
      pay_to: o.pay_to, payer, payment_request_id: o.payment_request_id,
      payment_payload: { payload: { signature: '' } },
      payment_mandate_contents: o.cart_mandate.contents,
    };
  }

  #finalizePayment({ signature, payment_payload, payment_mandate_contents, cart_hash }) {
    const o = [...this.orders.values()].find((x) => x.state === 'prepared' && x.quote);
    if (!o) return { error: { code: 10003, message: 'no prepared payment' } };
    if (cart_hash !== sha256hex(canonicalJson(o.cart_mandate.contents))) return { error: { code: 10001, message: 'cart_hash mismatch' } };
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature ?? '')) return { error: { code: 10001, message: 'signature must be 65-byte hex' } };
    if (this.now() > o.quote.expiresMs) return { error: { code: 30043, message: 'quote expired; call prepare_payment again' } };
    const payment_hash = '0x' + sha256hex(signature + o.flow_id);
    o.state = 'finalized';
    o.payment_mandate_json = JSON.stringify({
      payment_hash, payment_request_id: o.payment_request_id, flow_id: o.flow_id,
      // The server alone assembles the JWT; the client never does.
      jwt: `MOCK-SERVER-JWT.${Buffer.from(String(o.quote.attempts)).toString('base64')}.sig`,
      payment_payload: { ...payment_payload, payload: { ...payment_payload?.payload, signature } },
      payment_mandate_contents,
    });
    return { payment_mandate_json: o.payment_mandate_json, payment_hash };
  }

  #submitPayment({ payment_mandate_json }) {
    let pm;
    try { pm = JSON.parse(payment_mandate_json); } catch { return { error: { code: 10001, message: 'payment_mandate_json must be the JSON returned by finalize_payment' } }; }
    const o = this.orders.get(pm?.flow_id);
    if (!o || o.payment_mandate_json !== payment_mandate_json) return { error: { code: 10001, message: 'unknown or altered payment_mandate_json' } };
    if (this.now() > o.quote.expiresMs) return { error: { code: 30043, message: 'quote expired; call prepare_payment again' } };
    o.state = 'submitted';
    o.stage = 0;
    o.tx_signature = '0xMOCK' + crypto.randomBytes(30).toString('hex');
    return { status: 'payment-submitted', flow_id: o.flow_id, payment_request_id: o.payment_request_id };
  }

  #queryPayment({ flow_id, payment_request_id, expected_merchant_name }) {
    const o = flow_id ? this.orders.get(flow_id) : [...this.orders.values()].find((x) => x.payment_request_id === payment_request_id);
    if (!o) return { error: { code: 10003, message: 'payment not found' } };
    if (o.state !== 'submitted') return { status: 'payment-submitted', flow_id: o.flow_id, payment_request_id: o.payment_request_id, tx_signature: '', attribution_verified: expected_merchant_name === o.merchant_name };
    if (this.alwaysTimeout) {
      return { status: 'payment-timeout', flow_id: o.flow_id, payment_request_id: o.payment_request_id, tx_signature: o.tx_signature, attribution_verified: expected_merchant_name === o.merchant_name };
    }
    o.stage = Math.min(o.stage + this.advancePerQuery, POLL_STATES.length - 1);
    const status = POLL_STATES[o.stage];
    return {
      status, flow_id: o.flow_id, payment_request_id: o.payment_request_id,
      tx_signature: o.tx_signature,
      attribution_verified: expected_merchant_name === o.merchant_name,
      ...(status === 'payment-failed' ? { status_reason: 'mock failure' } : {}),
    };
  }

  // test helper: force a failure on next query
  failNext(flowId, reason) {
    const o = this.orders.get(flowId);
    if (o) { o.stage = -1; o.forceFail = reason; }
  }
}
