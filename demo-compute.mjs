import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MockHspMcpServer } from './src/mcp/mockServer.js';
import { McpClient, InProcessTransport } from './src/mcp/client.js';
import { HspAgenticPayment } from './src/mcp/hspAgenticPayment.js';
import { signTypedData, privateKeyToAddress } from './src/mcp/eip712.js';
import { verifyDelivery } from './src/verification.js';

// ONE NARROW A2A COMPUTE PURCHASE, end to end (mock HSP - NO live payments):
//   a compute-provider agent performs a REAL transcode job here in this
//   workspace; the buyer-side verifier independently checks the delivered
//   artifact against the buyer-declared acceptance suite; only on PASS does
//   the payment agent run the official HSP flow (order -> prepare ->
//   EIP-712 wallet signature -> finalize -> submit -> status recovery).
// Then a deliberately bad delivery shows the gate refusing payment.
//
// Honest boundaries:
//  - the compute job runs LOCALLY in this demo; in production the provider
//    runs on its own infrastructure and ships artifacts;
//  - the verifier proves the DELIVERED ARTIFACT meets the declared checks.
//    It does NOT prove who executed the job, how much compute was used
//    (no resource metering), or anything about a provider's creditworthiness;
//  - the HSP side is a local mock of the documented MCP contract. The
//    EIP-712 signing is real (@noble/secp256k1, recovery-verified). Live
//    HSP QA compatibility is UNVERIFIED (IP allowlisting + network block).

const ROOT = new URL('./compute-artifacts', import.meta.url).pathname;
const SRC = path.join(ROOT, 'input-tone.wav');
const OUT = path.join(ROOT, 'OUTPUT.opus');
const PAYER_KEY = '0x' + 'aa'.repeat(32); // throwaway dev key, no funds
const PAYER = privateKeyToAddress(PAYER_KEY);
const PROVIDER_ADDR = '0x' + 'bb'.repeat(20);

// Provider agent's work: generate the agreed source and transcode it.
const providerDoJob = (bad = false) => {
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5', '-ac', '2', SRC]);
  if (bad) {
    // bad delivery: wrong codec (mp3), wrong duration
    spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', SRC, '-t', '2', '-codec:a', 'libmp3lame', OUT]);
  } else {
    spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', SRC, '-ac', '1', '-codec:a', 'libopus', '-b:a', '64k', OUT]);
  }
};

const brief = {
  requirements: [
    { id: 'req-output', text: 'transcoded artifact delivered', check: { type: 'file_exists', path: 'OUTPUT.opus' } },
    { id: 'req-acceptance', text: 'acceptance suite passes (executed by the buyer verifier)', check: { type: 'test_run' } },
  ],
};

const server = new MockHspMcpServer({ advancePerQuery: 6 });
const mcp = new McpClient(new InProcessTransport(server));
const payer = new HspAgenticPayment({
  mcp, merchantName: 'BountyPilot Compute Demo',
  signTypedDataImpl: (td) => signTypedData(td, PAYER_KEY),
  confirm: async (kind, d) => {
    console.log(`   [approval gate:${kind}] pay_to=${d.pay_to ?? '-'} token_total_raw=${d.token_total_raw ?? '-'} -> approved (demo auto-approve)`);
    return true;
  },
  pollIntervalMs: 1, sleep: () => Promise.resolve(),
});

console.log('== A2A compute purchase with verify-before-pay on the HSP flow ==');
console.log('   (mock HSP server; real compute; real EIP-712 signing; NO live funds)\n');

console.log('1) Provider agent delivers the transcode job');
providerDoJob(false);
console.log('   provider: 5s stereo 48kHz WAV -> Opus 48kHz mono (ffmpeg, run here)');

console.log('\n2) Buyer verifier checks the delivery ITSELF');
const v = verifyDelivery(brief.requirements, { artifactRoot: ROOT });
for (const r of v.results) console.log(`   ${r.status} ${r.requirement.id}: ${r.reason}`);
console.log(`   verdict: ${v.verdict}`);

if (v.verdict === 'PASS') {
  console.log('\n3) Verdict PASS -> payment agent runs the official HSP flow');
  const res = await payer.pay({ payTo: PROVIDER_ADDR, payerAddress: PAYER, amountUsd: '1.00', label: 'compute: transcode job 042' });
  console.log(`   HSP result: ${res.status}`);
  console.log(`   team attribution verified: ${res.team_attribution_verified}`);
  console.log(`   raw authorization amount (raw units): ${res.token_total_raw}`);
  console.log(`   tx: ${res.tx_signature}`);
  console.log(`   note: ${res.note}`);
}

console.log('\n4) Bad delivery (wrong codec, truncated) -> gate refuses payment');
providerDoJob(true);
const vBad = verifyDelivery(brief.requirements, { artifactRoot: ROOT });
for (const r of vBad.results) console.log(`   ${r.status} ${r.requirement.id}: ${r.reason}`);
console.log(`   verdict: ${vBad.verdict}`);
const orders = server.calls.filter((c) => c.name === 'create_order').length;
console.log(`   payment created for bad delivery: NO | total orders created: ${orders} (only the verified one)`);
providerDoJob(false); // restore good output

console.log('\n== End. Verifier proved artifact properties only - not provenance, metering or creditworthiness. ==');
