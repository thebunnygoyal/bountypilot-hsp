import test from 'node:test';
import assert from 'node:assert/strict';
import { MockHspMcpServer } from '../src/mcp/mockServer.js';
import { McpClient, InProcessTransport, McpToolError } from '../src/mcp/client.js';
import { HspAgenticPayment } from '../src/mcp/hspAgenticPayment.js';
import { signTypedData, privateKeyToAddress } from '../src/mcp/eip712.js';

const KEY = '0x' + 'aa'.repeat(32);
const PAYER = privateKeyToAddress(KEY);
const WORKER = '0x' + 'bb'.repeat(20);
const TEAM = 'BountyPilot';

const setup = (opts = {}, over = {}) => {
  const server = new MockHspMcpServer(opts);
  const mcp = new McpClient(new InProcessTransport(server));
  const confirmations = [];
  const confirm = async (kind, details) => { confirmations.push({ kind, details }); return over.confirmResult ?? true; };
  const agent = new HspAgenticPayment({
    mcp, merchantName: TEAM, confirm,
    signTypedDataImpl: (td) => signTypedData(td, KEY),
    balanceOf: over.balanceOf ?? null,
    pollIntervalMs: 1, sleep: () => Promise.resolve(), now: opts.now ?? (() => Date.now()),
    maxPollMs: over.maxPollMs ?? 60_000,
  });
  return { server, mcp, agent, confirmations };
};

test('connect enforces the 8 required tools incl. finalize_payment', async () => {
  const server = new MockHspMcpServer();
  const mcp = new McpClient(new InProcessTransport(server));
  const tools = await mcp.connect();
  for (const t of McpClient.REQUIRED_TOOLS) assert.ok(tools.includes(t), t);
  const broken = { handle: (m2, p) => m2 === 'tools/list' ? { tools: [{ name: 'create_order' }] } : {} };
  await assert.rejects(() => new McpClient(new InProcessTransport(broken)).connect(), /finalize_payment/);
});

test('happy path: order -> prepare -> sign -> finalize -> submit -> finalized, attributed to team', async () => {
  const { agent, server, confirmations } = setup({ advancePerQuery: 6 });
  const res = await agent.pay({ payTo: WORKER, payerAddress: PAYER, amountUsd: '1.00', label: 'bounty payout' });
  assert.equal(res.status, 'payment-finalized');
  assert.equal(res.team_attribution_verified, true);
  assert.equal(res.team, TEAM);
  assert.match(res.tx_signature, /^0xMOCK/);
  // confirmations happened at order, sign and submit gates
  assert.deepEqual(confirmations.map((c) => c.kind), ['create-order', 'sign', 'submit']);
  // client passed payment_mandate_json UNCHANGED from finalize to submit
  const finCall = server.calls.find((c) => c.name === 'finalize_payment');
  const subCall = server.calls.find((c) => c.name === 'submit_payment');
  assert.equal(subCall.args.payment_mandate_json, server.orders.get(finCall && res.flow_id).payment_mandate_json);
  // server-side pay_to override was applied from the supplied pay_to
  const order = server.orders.get(res.flow_id);
  assert.equal(order.cart_mandate.contents.payment_request.method_data[0].data.pay_to, WORKER);
});

test('signature is over the server-returned eip712 (EIP-3009 TransferWithAuthorization)', async () => {
  const { agent, server } = setup();
  const res = await agent.pay({ payTo: WORKER, payerAddress: PAYER, amountUsd: '1.00' });
  const fin = server.calls.find((c) => c.name === 'finalize_payment');
  const prep = server.calls.find((c) => c.name === 'prepare_payment');
  assert.equal(fin.args.signature.slice(0, 2), '0x');
  assert.equal(fin.args.signature.length, 132);
  assert.equal(prep.args.payer, PAYER);
  assert.equal(res.token_total_raw, '1000000'); // 1 USD at 6 decimals, gas advanced
});

test('aborts before signing when the sign confirmation is denied; nothing is finalized', async () => {
  const { agent, server } = setup({}, { confirmResult: false });
  const res = await agent.pay({ payTo: WORKER, payerAddress: PAYER, amountUsd: '1.00' });
  assert.equal(res.status, 'aborted');
  assert.equal(res.stage, 'create-order'); // first gate already refuses
  assert.ok(!server.calls.some((c) => c.name === 'finalize_payment'));
  assert.ok(!server.calls.some((c) => c.name === 'submit_payment'));
});

test('refuses to sign when payer balance is below token_total_raw', async () => {
  const { agent, server } = setup({}, { balanceOf: async () => '500000' }); // 0.5 USDC < 1 USDC
  const res = await agent.pay({ payTo: WORKER, payerAddress: PAYER, amountUsd: '1.00' });
  assert.equal(res.status, 'insufficient_balance');
  assert.ok(!server.calls.some((c) => c.name === 'finalize_payment'));
});

test('expired quote at finalize triggers error 30043 -> re-prepare and re-sign', async () => {
  let t = 1_000_000;
  const { agent, server } = setup({ now: () => t, advancePerQuery: 6 });
  // freeze time during first prepare, then jump past 5-minute quote validity
  const origConfirm = agent.confirm;
  let signCount = 0;
  agent.confirm = async (kind, d) => { if (kind === 'sign') { signCount++; if (signCount === 1) t += 6 * 60 * 1000; } return origConfirm(kind, d); };
  const res = await agent.pay({ payTo: WORKER, payerAddress: PAYER, amountUsd: '1.00' });
  assert.equal(res.status, 'payment-finalized');
  assert.equal(server.calls.filter((c) => c.name === 'prepare_payment').length, 2);
  const sigs = server.calls.filter((c) => c.name === 'finalize_payment').map((c) => c.args.signature);
  assert.equal(sigs.length, 2);
  assert.notEqual(sigs[0], sigs[1]); // new eip712 -> new signature; old one never resubmitted
});

test('payment-safe is reported as on-chain but NOT final', async () => {
  const { agent } = setup({ advancePerQuery: 4 }); // lands exactly on payment-safe
  const res = await agent.pay({ payTo: WORKER, payerAddress: PAYER, amountUsd: '1.00' });
  assert.equal(res.status, 'payment-safe');
  assert.match(res.note, /not yet finalized/i);
});

test('payment-timeout keeps polling the same payment, then reports pending-confirmation at the cap', async () => {
  let t = 1_000_000;
  const server = new MockHspMcpServer({ now: () => t, alwaysTimeout: true });
  const mcp = new McpClient(new InProcessTransport(server));
  const agent = new HspAgenticPayment({
    mcp, merchantName: TEAM, confirm: async () => true,
    signTypedDataImpl: (td) => signTypedData(td, KEY),
    now: () => t, pollIntervalMs: 15, maxPollMs: 50,
    sleep: (ms) => { t += ms; return Promise.resolve(); },
  });
  const res = await agent.pay({ payTo: WORKER, payerAddress: PAYER, amountUsd: '1.00' });
  assert.equal(res.status, 'pending-confirmation');
  assert.ok(res.flow_id && res.payment_request_id);
  const queries = server.calls.filter((c) => c.name === 'query_payment');
  assert.ok(queries.length >= 3); // kept polling the SAME payment
  for (const q of queries) assert.equal(q.args.flow_id, res.flow_id);
  assert.equal(server.calls.filter((c) => c.name === 'create_order').length, 1); // no duplicate order
  assert.equal(server.calls.filter((c) => c.name === 'submit_payment').length, 1); // no blind resubmit
});

test('team attribution mismatch is surfaced, not claimed', async () => {
  const { agent } = setup();
  const spy = agent.mcp.callTool.bind(agent.mcp);
  agent.mcp.callTool = async (name, args) => {
    const r = await spy(name, args);
    if (name === 'query_payment') r.attribution_verified = false;
    return r;
  };
  const res = await agent.pay({ payTo: WORKER, payerAddress: PAYER, amountUsd: '1.00' });
  assert.equal(res.team_attribution_verified, false);
});

test('gas_fee_advanced=false adds the fee into token_total_raw', async () => {
  const { agent } = setup({ gasFeeAdvanced: false });
  const res = await agent.pay({ payTo: WORKER, payerAddress: PAYER, amountUsd: '1.00' });
  assert.ok(BigInt(res.token_total_raw) > 1000000n);
});

test('create_order rejects a malformed cart (x402 v1) and bad pay_to', async () => {
  const { mcp } = setup();
  await assert.rejects(
    () => mcp.callTool('create_order', { merchant_name: TEAM, pay_to: 'not-an-address', cart_mandate: { contents: {} } }),
    (e) => e instanceof McpToolError && e.code === 10001,
  );
});
