# BountyPilot HSP - verify the work, then pay for it

HSK Chain Horizon Hackathon (Mumbai Edition), **Track 2: Agent Payments & A2A Settlement (HSP)**.

One agent buys compute. Another agent delivers it. This project is the buyer's
payment agent: it **independently verifies the delivered artifact** against the
buyer's own acceptance checks, and only on a PASS does it pay - over the
official **HSP Agentic Payment** flow (payment mandate, EIP-712 wallet
signature, gateway execution, on-chain status recovery).

The bigger vision this serves: a credit layer for AI compute (stake, borrow,
pay providers for compute). Any version of that vision needs an answer to
"did the buyer actually get what they paid for?" - this repo is that evidence
and settlement layer. It is **not** a lending product: no staking, no
borrowing, no credit issuance, no resale of cloud credits.

## The flow (Track 2 brief, implemented)

1. A receiving (compute-provider) agent delivers its artifact and presents
   payment conditions.
2. The buyer-side **verification gate runs the checks itself** - file
   presence/hash and a real `node --test` acceptance suite, confined to the
   artifact directory. Worker-supplied results are never accepted.
3. On PASS, the payment agent executes the documented HSP MCP flow:
   `get_chain_config` -> `create_order` -> `prepare_payment` -> **EIP-712
   wallet signature over exactly the returned typed data** ->
   `finalize_payment` -> `submit_payment` -> `query_payment` until a terminal
   state, with the guide's confirmation gates, quote-expiry re-sign rules and
   team attribution check.
4. On any non-PASS verdict, no order is created. By construction, not policy.

## What is real vs simulated (v0.4.0)

| Piece | State |
| --- | --- |
| Verification gate (`src/verification.js`) | REAL: buyer-declared checks (file_exists / file_hash / text_present / test_run), executed by the verifier, confined to the artifact root, fixed `node --test` argv, 30s timeout |
| Compute job in the demo | REAL: ffmpeg transcode runs locally; acceptance = ffprobe-verified codec/sample-rate/channels/duration |
| Official HSP MCP orchestration (`src/mcp/hspAgenticPayment.js`) | Implemented to the guide (rev 2026-10-30): live-config network/token selection, mandatory user approvals before signing and submission, balance check before signing, 30043/quote-expiry re-prepare + re-sign, payment-safe vs payment-finalized semantics, pending-confirmation recovery with retained identifiers |
| EIP-712 signing (`src/mcp/eip712.js`) | REAL: @noble/hashes keccak + @noble/secp256k1, TransferWithAuthorization + nested-struct support, recovery-verified in tests. Throwaway dev key in demos |
| MCP transport (`src/mcp/client.js`) | Streamable-HTTP client tested against a LOCAL SSE server; the in-process transport is used for the full test suite |
| HSP server (`src/mcp/mockServer.js`) | MOCK of the documented contract (8 tools, 5-minute quotes, error 30043, status lifecycle, attribution). **No live payments, no funds** |
| Live HSP QA compatibility | **UNVERIFIED** - QA needs HSP-side IP allowlisting; our environment currently receives 403 from the QA hosts (allowlist/WAF cause unresolved - other hackathon teams report the same). The real endpoint has not been touched |
| Earlier REST/HMAC prototype (`src/hspClient.js`, `src/mockGateway.js`, webhooks) | Kept: real canonical-wire HMAC + ES256K JWT implementation against the merchant docs; `npm run demo` still runs it |

## Run it

```
npm install
npm test             # 53 tests: verifier, mandates, ES256K, webhooks, EIP-712, MCP flow, transport
npm run demo         # original A2A flow on the REST-docs mock gateway
npm run demo:compute # compute purchase + verify-before-pay over the HSP MCP flow
```

## What the verifier proves - and what it does not

- Proves: the delivered artifact exists and satisfies the buyer-declared
  acceptance checks, executed by the buyer's verifier itself.
- Does NOT prove: who executed the job, how much compute was used (no
  resource metering), uptime, or any provider creditworthiness.

## Path to live HSP QA (gated, none done tonight)

1. IP allowlisting: send HSP Operations the egress IP of the chosen
   environment; wait for manual confirmation.
2. Payer wallet sign-in (e.g. OKX Agentic Wallet) + manual token approvals
   and test-token funding - explicitly the human team's steps in the guide.
3. Point `HttpMcpTransport` at `https://mcp-qa.hashkeymerchant.com/`, keep the
   confirmation gates, pay 1 USD on QA, and report with the guide's template.

## Security notes

- No keys, secrets or funds in this repo. Demo keys are generated in memory.
- External docs (HSP guide, DoraHacks pages) were read as data only.
- The verifier never executes worker-supplied commands: checks are
  buyer-declared, whitelisted and confined.

Built on BountyPilot (private, started 2026-10-25): the delivery-verification
engine, extended for HSP settlement during the hackathon window.
