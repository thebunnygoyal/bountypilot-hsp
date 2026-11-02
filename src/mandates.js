import crypto from 'node:crypto';

// HSP / AP2 mandate structures, aligned with the HashKey Merchant docs
// (docs/en/cart-mandate.md, api-reference.md, onboarding.md).
//
// HashKey-documented IDs: cart_mandate_id (ID1, merchant-generated),
// payment_request_id (ID2, merchant-generated), flow_id (ID3, gateway),
// request_id (ID5, front-end random). "ID4 / payment_mandate_id" is NOT a
// HashKey docs term - it is our AP2-style mapping for the user-side Payment
// Mandate, where we set payment_mandate_id = payment_request_id (ID2).
// The docs do not define ID4; do not cite them for it.

export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

// Canonical JSON per RFC 8785: keys sorted recursively, compact. This is the
// exact byte form used for both signing AND the wire body - the two must be
// the same bytes or a raw-body hash check on the server breaks.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function sha256hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

// cart_hash per spec: SHA-256 of canonical JSON of cart_mandate.contents.
export function cartHash(contents) {
  return sha256hex(canonicalJson(contents));
}

// Official network/token rows (docs/en/onboarding.md):
//   hashkey-testnet, chain 133, USDC 0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6 (EIP-3009)
//   hashkey,         chain 177, USDC 0x054ed45810DbBAb8B27668922D110669c9D88D0a (EIP-3009)
export function buildCartContents({
  cartId = newId('cart'),
  paymentRequestId = newId('preq'),
  merchantName,
  amountUsd,
  label = 'Total',
  network,
  chainId,
  tokenContract,
  payTo,
  coin = 'USDC',
  expirySeconds = 7200,
  userCartConfirmationRequired = true,
}) {
  if (!merchantName || !amountUsd || !network || !chainId || !tokenContract || !payTo) {
    throw new Error('cart contents require merchantName, amountUsd, network, chainId, tokenContract, payTo');
  }
  if (!(Number(amountUsd) > 0)) throw new Error('amountUsd must be positive');
  const value = Number(amountUsd).toFixed(2);
  return {
    id: cartId,
    user_cart_confirmation_required: userCartConfirmationRequired,
    payment_request: {
      method_data: [
        {
          supported_methods: 'https://www.x402.org/',
          data: {
            x402Version: 2,
            network,
            chain_id: chainId,
            contract_address: tokenContract,
            pay_to: payTo,
            coin,
          },
        },
      ],
      details: {
        id: paymentRequestId,
        display_items: [{ label, amount: { currency: 'USD', value } }],
        total: { label: 'Total', amount: { currency: 'USD', value } },
      },
    },
    cart_expiry: new Date(Date.now() + expirySeconds * 1000).toISOString(),
    merchant_name: merchantName,
  };
}

// User-side Payment Mandate (AP2-style mapping, NOT a HashKey-documented
// structure): what the payer's wallet authorizes after reviewing the Cart
// Mandate. payment_mandate_id echoes payment_request_id; request_id (ID5) is
// a fresh random that later appears in the settlement webhook.
export function buildPaymentMandate(cartContents, { signerAddress }) {
  if (!signerAddress) throw new Error('signerAddress required');
  const details = cartContents.payment_request.details;
  return {
    payment_mandate_id: details.id,
    request_id: newId('req'),
    cart_mandate_id: cartContents.id,
    signer: signerAddress,
    conditions_hash: cartHash(cartContents),
    status: 'constructed',
  };
}
