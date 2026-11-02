import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';

// @noble/secp256k1 v3 needs explicit hash wiring for deterministic signing.
secp.hashes.sha256 = sha256;
secp.hashes.hmacSha256 = (key, ...msgs) => hmac(sha256, key, concatBytes(...msgs));

// Minimal, dependency-light EIP-712 typed-data hashing and secp256k1 signing.
// Covers the HSP guide's two primaryTypes: TransferWithAuthorization
// (eip3009) and PermitTransferFrom (permit2, one nested struct level), plus
// generic primitive types (address, uintN, bytesN, bool, string, bytes).
// Signs ONLY the server-returned eip712 object: domain, types, primaryType
// and message are preserved exactly as received (guide step 7).

const PRIMITIVE = /^(address|bool|u?int(8|16|32|64|128|256)?|bytes([1-9]|[12][0-9]|3[0-2])?|string)$/;

function encodeType(primaryType, types) {
  const deps = new Set();
  const collect = (t) => {
    for (const { type } of types[t]) {
      const base = type.replace(/\[\]$/, '');
      if (!PRIMITIVE.test(base) && base !== t && types[base]) deps.add(base);
    }
  };
  collect(primaryType);
  const all = [primaryType, ...[...deps].sort()];
  return all
    .map((t) => `${t}(${types[t].map(({ name, type }) => `${type} ${name}`).join(',')})`)
    .join('');
}

function abiValue(type, value) {
  if (type === 'address') {
    const b = hexToBytes(String(value).toLowerCase().replace(/^0x/, ''));
    if (b.length !== 20) throw new Error('bad address length');
    return concatBytes(new Uint8Array(12), b);
  }
  if (/^u?int/.test(type)) {
    const hex = BigInt(value).toString(16).padStart(64, '0');
    return hexToBytes(hex);
  }
  if (type === 'bool') return hexToBytes(value ? '01'.padStart(64, '0') : '00'.padStart(64, '0'));
  if (/^bytes[0-9]+$/.test(type)) {
    const b = hexToBytes(String(value).replace(/^0x/, ''));
    const out = new Uint8Array(32);
    out.set(b);
    return out;
  }
  if (type === 'bytes' || type === 'string') {
    const data = type === 'string' ? new TextEncoder().encode(value) : hexToBytes(String(value).replace(/^0x/, ''));
    return keccak_256(data); // dynamic types are hashed
  }
  throw new Error(`unsupported eip712 type ${type}`);
}

function hashStruct(primaryType, types, message) {
  const typeHash = keccak_256(new TextEncoder().encode(encodeType(primaryType, types)));
  const parts = [typeHash];
  for (const { name, type } of types[primaryType]) {
    const base = type.replace(/\[\]$/, '');
    if (!PRIMITIVE.test(base) && types[base]) {
      parts.push(hashStruct(base, types, message[name])); // nested struct
    } else {
      parts.push(abiValue(type, message[name]));
    }
  }
  return keccak_256(concatBytes(...parts));
}

export function eip712Digest(typedData) {
  const { domain, types, primaryType, message } = typedData;
  if (!domain || !types || !primaryType || !message) throw new Error('incomplete eip712 payload');
  const domainTypes = { EIP712Domain: types.EIP712Domain };
  const domainSeparator = hashStruct('EIP712Domain', domainTypes, domain);
  const structHash = hashStruct(primaryType, types, message);
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), domainSeparator, structHash));
}

export function privateKeyToAddress(privateKeyHex) {
  const pub = secp.getPublicKey(hexToBytes(privateKeyHex.replace(/^0x/, '')), false).slice(1);
  return '0x' + bytesToHex(keccak_256(pub).slice(-20));
}

// Returns a 65-byte 0x-prefixed r||s||v signature over the eip712 digest.
export function signTypedData(typedData, privateKeyHex) {
  const digest = eip712Digest(typedData);
  const priv = hexToBytes(privateKeyHex.replace(/^0x/, ''));
  const sigR = secp.sign(digest, priv, { lowS: true, format: 'recovered' }); // recid || r || s
  const v = 27 + sigR[0];
  return '0x' + bytesToHex(concatBytes(sigR.slice(1), new Uint8Array([v])));
}

// Recover the signer address, for tests and sanity checks.
export function recoverTypedDataSigner(typedData, signatureHex) {
  const digest = eip712Digest(typedData);
  const raw = hexToBytes(signatureHex.replace(/^0x/, ''));
  if (raw.length !== 65) throw new Error('signature must be 65 bytes');
  const v = raw[64];
  const compressed = secp.recoverPublicKey(concatBytes(new Uint8Array([v - 27]), raw.slice(0, 64)), digest);
  const pub = secp.Point.fromBytes(compressed).toBytes(false).slice(1);
  return '0x' + bytesToHex(keccak_256(pub).slice(-20));
}
