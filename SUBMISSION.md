# BUIDL submission draft (for review - nothing submitted)

**Project name:** BountyPilot HSP

**Tagline:** Agents that pay for compute only when the delivered work passes the buyer's own checks - settled over HSP.

**Track:** Track 2 - Agent Payments & A2A Settlement (HSP)

**Short description (paste-ready):**

AI agents are starting to buy compute and services from each other, but a
paying agent today has to trust that the work it paid for was actually
delivered. BountyPilot HSP is the payment agent that does not trust: it runs
the buyer's own acceptance checks against the delivered artifact itself -
file integrity and a real test-suite execution, confined to the delivery -
and only when every check passes does it build the HSP Payment Mandate,
EIP-712-sign the authorization (a generated development key in this demo; the
human confirmation gates for a real wallet approval are implemented and shown
auto-approved), and execute the payment through the HSP Gateway. Failed or unverifiable work never reaches a payment: no order, no
signature, no settlement.

The demo is one narrow A2A transaction end to end: a provider agent performs
a real transcode job, the buyer verifier proves codec, sample rate, channels
and duration from the delivered file, and a simulated 1 USD payment then settles over
the documented HSP Agentic Payment flow (create_order -> prepare_payment ->
wallet signature -> finalize_payment -> submit_payment -> status recovery
with team attribution). A second, tampered delivery is refused by the gate.

This is the evidence-and-settlement layer that agentic compute markets - and
any future compute-credit product - need before money can safely move.

Honest state: full flow implemented to the official guide (rev 2026-10-30)
with real EIP-712 signing and 53 passing tests; live HSP QA execution is
not yet demonstrated (organiser IP allowlisting and a 403 access issue are
both unresolved), so the demo settles against a mock that enforces the
documented contract. No lending, staking or credit
issuance is claimed.

**Demo video script (~75 seconds, terminal recording + voiceover):**

1. (5s) "Agents will buy compute from each other. Here's a payment agent that refuses to pay for work it can't verify."
2. (15s) Show the brief: acceptance checks the buyer declared (artifact present + ffprobe-verified transcode properties).
3. (20s) Run `npm run demo:compute`. Narrate: provider transcodes; the buyer's verifier runs the checks itself - not the provider's word.
4. (20s) Point at the HSP flow executing: mandate created, EIP-712 signature (throwaway dev key; confirmation gates auto-approved for the demo), submission, status polling to final confirmation, team attribution verified.
5. (10s) Show the tampered delivery being refused - no order created.
6. (5s) "Verify first, then pay - on HSP. Code and tests in the repo."

**Repo:** no hosted repository exists yet - this build is a local archive. Creating or pushing a public repo needs the owner's explicit go.
