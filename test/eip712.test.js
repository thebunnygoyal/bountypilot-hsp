import test from 'node:test';
import assert from 'node:assert/strict';
import { eip712Digest, signTypedData, recoverTypedDataSigner, privateKeyToAddress } from '../src/mcp/eip712.js';

const KEY = '0x' + '11'.repeat(32);
const PAYER = privateKeyToAddress(KEY);
const TOKEN = '0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6';

const typedData = () => ({
  domain: { name: 'USD Coin', version: '2', chainId: 133, verifyingContract: TOKEN },
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
    from: PAYER, to: '0x' + '22'.repeat(20), value: '1000000',
    validAfter: '0', validBefore: '1999999999', nonce: '0x' + '33'.repeat(32),
  },
});

test('eip712 digest is deterministic and domain-sensitive', () => {
  const a = eip712Digest(typedData());
  assert.equal(a.length, 32);
  assert.deepEqual(eip712Digest(typedData()), a);
  const other = typedData();
  other.domain.chainId = 177; // mainnet domain must hash differently
  assert.notDeepEqual(eip712Digest(other), a);
  const otherMsg = typedData();
  otherMsg.message = { ...otherMsg.message, value: '1000001' };
  assert.notDeepEqual(eip712Digest(otherMsg), a);
});

test('signs a 65-byte r||s||v signature that recovers the payer address', () => {
  const sig = signTypedData(typedData(), KEY);
  assert.match(sig, /^0x[0-9a-f]{130}$/);
  assert.equal(recoverTypedDataSigner(typedData(), sig), PAYER);
  assert.equal(signTypedData(typedData(), KEY), sig); // deterministic (RFC6979)
});

test('a different key or tampered message recovers a different address', () => {
  const otherKeySig = signTypedData(typedData(), '0x' + '44'.repeat(32));
  assert.notEqual(recoverTypedDataSigner(typedData(), otherKeySig), PAYER);
  const tampered = typedData();
  tampered.message = { ...tampered.message, value: '999' };
  assert.notEqual(recoverTypedDataSigner(tampered, signTypedData(typedData(), KEY)), PAYER);
});

test('nested struct support (permit2-style TokenPermissions)', () => {
  const td = {
    domain: { name: 'Permit2', version: '1', chainId: 133, verifyingContract: '0x' + '55'.repeat(20) },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
      ],
      PermitTransferFrom: [
        { name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
      ],
      TokenPermissions: [
        { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' },
      ],
    },
    primaryType: 'PermitTransferFrom',
    message: {
      permitted: { token: TOKEN, amount: '1000000' },
      spender: '0x' + '66'.repeat(20), nonce: '0', deadline: '1999999999',
    },
  };
  const sig = signTypedData(td, KEY);
  assert.equal(recoverTypedDataSigner(td, sig), PAYER);
});
