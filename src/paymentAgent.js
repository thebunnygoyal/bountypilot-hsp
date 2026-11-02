import { buildCartContents, buildPaymentMandate } from './mandates.js';
import { signMerchantAuthorization, generateMerchantKeypair } from './es256k.js';
import { verifyDelivery } from './verification.js';

// The paying agent in the A2A pair. Receives payment conditions from the
// receiving (worker) agent, verifies the delivered work itself (bounded real
// verifier, buyer-declared checks), and only then builds the Cart Mandate,
// signs the ES256K merchant_authorization JWT, creates the order via the HSP
// client, and constructs the user-side Payment Mandate for wallet signature.
//
// Hard rules:
//  - no verification PASS -> no order is ever created;
//  - merchant signing key is injected (never hardcoded);
//  - an order is 'awaiting_payer' until the wallet step and settlement
//    webhook; this agent never claims payment completion on order creation;
//  - every state change is appended to the ledger for the NL interface.

export class PaymentAgent {
  constructor({ merchantName, hsp, merchantKey, payerAddress, network, chainId, tokenContract, ledger = [] }) {
    this.merchantName = merchantName;
    this.hsp = hsp;
    this.merchantKey = merchantKey; // { privateKey, publicKey }
    this.payerAddress = payerAddress;
    this.network = network;
    this.chainId = chainId;
    this.tokenContract = tokenContract;
    this.ledger = ledger;
  }

  log(entry) {
    this.ledger.push({ at: new Date().toISOString(), ...entry });
  }

  async handlePaymentConditions(conditions, requirements, { artifactRoot } = {}) {
    this.log({ event: 'conditions_received', from: conditions.from_agent, amountUsd: conditions.amountUsd, coin: conditions.coin });
    const verification = verifyDelivery(requirements, { artifactRoot });
    this._lastVerification = verification;
    this.log({ event: 'verification', verdict: verification.verdict });
    if (verification.verdict !== 'PASS') {
      this.log({ event: 'payment_refused', reason: 'verification not passed' });
      return { status: 'verification_failed', verification };
    }
    const contents = buildCartContents({
      merchantName: this.merchantName,
      amountUsd: conditions.amountUsd,
      label: conditions.memo || 'A2A settlement',
      network: this.network,
      chainId: this.chainId,
      tokenContract: this.tokenContract,
      payTo: conditions.recipient,
      coin: conditions.coin || 'USDC',
    });
    const jwt = signMerchantAuthorization({ privateKey: this.merchantKey.privateKey, merchantName: this.merchantName, contents });
    const cartMandate = { contents, merchant_authorization: jwt };
    const order = await this.hsp.createOrder(cartMandate);
    this.log({ event: 'order_created', payment_request_id: order.data.payment_request_id, cart_mandate_id: contents.id, state: 'payment-required' });
    const mandate = buildPaymentMandate(contents, { signerAddress: this.payerAddress });
    this.log({ event: 'mandate_constructed', payment_mandate_id: mandate.payment_mandate_id, request_id: mandate.request_id });
    return { status: 'awaiting_payer', verification, cartMandate, order: order.data, mandate };
  }

  noteSettlement({ paymentRequestId, status }) {
    this.log({ event: 'settled', payment_request_id: paymentRequestId, status });
  }

  answer(question) {
    const q = String(question).toLowerCase();
    const last = this.ledger[this.ledger.length - 1];
    if (!last) return 'No payment activity yet.';
    if (q.includes('why')) {
      const failed = (this._lastVerification?.results || []).filter((r) => r.status !== 'PASS');
      if (last.event === 'payment_refused') {
        return `Payment was refused: verification did not pass (${failed.map((f) => `${f.requirement.id}: ${f.reason}`).join('; ') || 'see ledger'}).`;
      }
    }
    if (q.includes('status') || q.includes('paid') || q.includes('pending')) {
      // Pick by ledger position, not timestamp: same-millisecond entries are
      // common and must not reorder.
      const idx = { settled: -1, refused: -1, awaiting: -1 };
      this.ledger.forEach((e, i) => {
        if (e.event === 'settled') idx.settled = i;
        else if (e.event === 'payment_refused') idx.refused = i;
        else if (e.event === 'mandate_constructed') idx.awaiting = i;
      });
      const latestKind = Object.entries(idx).filter(([, i]) => i >= 0).sort((a, b) => b[1] - a[1])[0]?.[0];
      const settled = idx.settled >= 0 ? this.ledger[idx.settled] : null;
      const refused = idx.refused >= 0 ? this.ledger[idx.refused] : null;
      const awaiting = idx.awaiting >= 0 ? this.ledger[idx.awaiting] : null;
      const latest = latestKind === 'settled' ? settled : latestKind === 'refused' ? refused : awaiting;
      if (latest === settled) return `Latest payment settled (${settled.status}), payment_request ${settled.payment_request_id}.`;
      if (latest === refused) return 'Latest payment was refused at verification.';
      if (latest === awaiting) {
        const order = [...this.ledger].reverse().find((e) => e.event === 'order_created');
        return `Latest payment order created on HSP, payment_request ${order?.payment_request_id}, state payment-required. Awaiting wallet signature and settlement.`;
      }
    }
    return `Last event: ${last.event} at ${last.at}.`;
  }
}

// Development signer: generates a THROWAWAY secp256k1 merchant keypair in
// memory and produces real, verifiable ES256K JWTs. Holds no user keys and
// controls no funds. Production swaps in the merchant's registered keypair.
export class DevMerchantKey {
  constructor() {
    this.keypair = generateMerchantKeypair();
  }
  get privateKey() { return this.keypair.privateKey; }
  get publicKey() { return this.keypair.publicKey; }
}
