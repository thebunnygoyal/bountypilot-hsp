import { buildCartContents } from '../mandates.js';
import { signTypedData } from './eip712.js';
import { McpToolError } from './client.js';

// Orchestrates the official HSP Agentic Payment flow (guide rev 2026-10-30):
//   get_chain_config -> create_order -> prepare_payment -> wallet signature
//   over the returned eip712 ONLY -> finalize_payment -> submit_payment ->
//   query_payment with the documented status semantics and recovery rules.
//
// Hard rules (from the guide, enforced here):
//  - network/token values come from the LIVE get_chain_config response,
//    never from memory or constants;
//  - explicit user confirmation before signing and again before submission;
//  - never sign if the payer balance is below token_total_raw;
//  - payment_mandate_json is passed to submit_payment UNCHANGED - the client
//    never inserts signatures, hashes or assembles a JWT;
//  - on quote expiry / error 30043, re-prepare and re-sign (bounded), never
//    resubmit an old signature;
//  - payment-safe is NOT final; only payment-finalized is final;
//  - team attribution is reported only when attribution_verified is true.

const POLL_CONTINUE = new Set(['payment-submitted', 'payment-verified', 'payment-processing', 'payment-included', 'payment-timeout']);
const QUOTE_EXPIRED = 30043;

export class HspAgenticPayment {
  constructor({
    mcp, merchantName, signTypedDataImpl, confirm, balanceOf = null,
    now = () => Date.now(), pollIntervalMs = 15000, maxPollMs = 10 * 60 * 1000,
    maxReprepares = 2, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = [],
  }) {
    if (!mcp) throw new Error('mcp client required');
    if (!merchantName) throw new Error('merchantName (team reporting name) required');
    if (typeof confirm !== 'function') throw new Error('confirm(kind, details) callback required - the guide mandates explicit approval');
    if (typeof signTypedDataImpl !== 'function') throw new Error('signer required');
    Object.assign(this, { mcp, merchantName, signTypedDataImpl, confirm, balanceOf, now, pollIntervalMs, maxPollMs, maxReprepares, sleep, log });
  }

  #entry(entry) { this.log.push({ at: new Date(this.now()).toISOString(), ...entry }); }

  async #selectPaymentConfig() {
    const config = await this.mcp.callTool('get_chain_config', {});
    for (const net of config?.networks ?? []) {
      for (const token of net?.tokens ?? []) {
        if (token?.address && token?.decimals != null && token?.payment_protocol) {
          return { network: net.network, chainId: net.chain_id, token };
        }
      }
    }
    throw new Error('get_chain_config returned no usable network/token - do not pick from memory');
  }

  async pay({ payTo, payerAddress, amountUsd, label = 'A2A settlement', expirySeconds = 7200 }) {
    const cfg = await this.#selectPaymentConfig();
    this.#entry({ event: 'chain_config', network: cfg.network, chainId: cfg.chainId, token: cfg.token.symbol, protocol: cfg.token.payment_protocol });

    // Guide step 6: merchant_name and pay_to are confirmed before create_order.
    const okOrder = await this.confirm('create-order', {
      merchant_name: this.merchantName, pay_to: payTo, payer: payerAddress,
      amount_usd: amountUsd, network: cfg.network, token: cfg.token.symbol,
    });
    if (!okOrder) { this.#entry({ event: 'aborted', stage: 'create-order' }); return { status: 'aborted', stage: 'create-order' }; }

    const contents = buildCartContents({
      merchantName: this.merchantName, amountUsd, label,
      network: cfg.network, chainId: cfg.chainId, tokenContract: cfg.token.address,
      payTo, coin: cfg.token.symbol, expirySeconds,
    });
    const order = await this.mcp.callTool('create_order', { merchant_name: this.merchantName, pay_to: payTo, cart_mandate: { contents } });
    const { flow_id, payment_request_id } = order;
    this.#entry({ event: 'order_created', flow_id, payment_request_id });

    let prepared = null;
    let signature = null;
    for (let attempt = 0; attempt <= this.maxReprepares; attempt++) {
      prepared = await this.mcp.callTool('prepare_payment', { flow_id, payer: payerAddress, protocol: cfg.token.payment_protocol });
      this.#entry({ event: 'prepared', token_total_raw: prepared.token_total_raw, quote_expires_at: prepared.quote_expires_at, attempt });

      if (this.balanceOf) {
        const bal = BigInt(await this.balanceOf(cfg.token.address, payerAddress));
        if (bal < BigInt(prepared.token_total_raw)) {
          this.#entry({ event: 'refused', reason: 'insufficient_balance', balance: bal.toString(), token_total_raw: prepared.token_total_raw });
          return { status: 'insufficient_balance', flow_id, payment_request_id, balance: bal.toString(), token_total_raw: prepared.token_total_raw };
        }
      }

      // Guide step 7: show pay_to, payer, token_total_raw; wait for approval.
      const okSign = await this.confirm('sign', { pay_to: prepared.pay_to, payer: prepared.payer, token_total_raw: prepared.token_total_raw, quote_expires_at: prepared.quote_expires_at });
      if (!okSign) { this.#entry({ event: 'aborted', stage: 'sign' }); return { status: 'aborted', stage: 'sign', flow_id, payment_request_id }; }

      // Sign ONLY the returned eip712, preserving domain/types/primaryType/message.
      signature = this.signTypedDataImpl(prepared.eip712);

      try {
        const fin = await this.mcp.callTool('finalize_payment', {
          signature,
          payment_payload: prepared.payment_payload,
          payment_mandate_contents: prepared.payment_mandate_contents,
          cart_hash: prepared.cart_hash,
        });
        prepared = { ...prepared, ...fin };
        break;
      } catch (e) {
        if (e instanceof McpToolError && e.code === QUOTE_EXPIRED && attempt < this.maxReprepares) {
          this.#entry({ event: 'quote_expired_reprepare', attempt });
          continue;
        }
        throw e;
      }
    }
    if (!prepared?.payment_mandate_json) { this.#entry({ event: 'error', stage: 'finalize' }); return { status: 'error', stage: 'finalize', flow_id, payment_request_id }; }

    // Guide step 7: second explicit approval before submission.
    const okSubmit = await this.confirm('submit', { pay_to: prepared.pay_to, payer: prepared.payer, token_total_raw: prepared.token_total_raw });
    if (!okSubmit) { this.#entry({ event: 'aborted', stage: 'submit' }); return { status: 'aborted', stage: 'submit', flow_id, payment_request_id }; }

    let submitted;
    try {
      submitted = await this.mcp.callTool('submit_payment', { payment_mandate_json: prepared.payment_mandate_json });
    } catch (e) {
      if (e instanceof McpToolError && e.code === QUOTE_EXPIRED) {
        this.#entry({ event: 'submit_quote_expired' });
        return { status: 'quote-expired-resubmit-needed', flow_id, payment_request_id };
      }
      throw e;
    }
    this.#entry({ event: 'submitted', status: submitted.status });

    // Guide step 8: poll the SAME payment; attribution must verify.
    const started = this.now();
    let last = null;
    for (;;) {
      await this.sleep(this.pollIntervalMs);
      last = await this.mcp.callTool('query_payment', { flow_id, payment_request_id, expected_merchant_name: this.merchantName });
      this.#entry({ event: 'poll', status: last.status, attribution_verified: last.attribution_verified });
      if (POLL_CONTINUE.has(last.status)) {
        if (this.now() - started > this.maxPollMs) {
          return this.#report('pending-confirmation', prepared, last, flow_id, payment_request_id);
        }
        continue;
      }
      if (last.status === 'payment-safe' || last.status === 'payment-finalized' || last.status === 'payment-failed') {
        return this.#report(last.status, prepared, last, flow_id, payment_request_id);
      }
      return this.#report('unrecognized-status', prepared, last, flow_id, payment_request_id);
    }
  }

  #report(status, prepared, last, flow_id, payment_request_id) {
    // The guide's result-report template; payment-safe is not final.
    const finalizedNote =
      status === 'payment-finalized' ? 'The payment has reached final confirmation.' :
      status === 'payment-safe' ? 'The transaction is on-chain and has received half of the required block confirmations. It is not yet finalized.' :
      status === 'payment-failed' ? `Payment failed: ${last?.status_reason ?? 'reason unavailable'}` :
      status === 'pending-confirmation' ? 'Pending confirmation - retain flow_id and payment_request_id and resume query_payment; do not create a replacement order.' :
      `Unrecognized status: ${last?.status}`;
    return {
      status,
      note: finalizedNote,
      flow_id, payment_request_id,
      team: this.merchantName,
      team_attribution_verified: last?.attribution_verified === true,
      token_total_raw: prepared?.token_total_raw,
      pay_to: prepared?.pay_to,
      payer: prepared?.payer,
      tx_signature: last?.tx_signature || 'unavailable',
    };
  }
}
