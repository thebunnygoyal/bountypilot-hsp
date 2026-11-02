import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyDelivery } from '../src/verification.js';

const root = path.resolve(new URL('../demo-artifacts', import.meta.url).pathname);
const HASH = 'e27677ef8376a4e3f947838e5957cf00e85f8da5e4d892212cf8467c0c483dc2';

test('real file_hash check passes on the pinned artifact', () => {
  const v = verifyDelivery([{ id: 'r1', text: 'x', check: { type: 'file_hash', path: 'DELIVERABLE.md', sha256: HASH } }], { artifactRoot: root });
  assert.equal(v.verdict, 'PASS');
  assert.match(v.results[0].reason, /sha256 match/);
});

test('hash mismatch fails (verifier computed it, not the worker)', () => {
  const v = verifyDelivery([{ id: 'r1', text: 'x', check: { type: 'file_hash', path: 'DELIVERABLE.md', sha256: 'deadbeef'.repeat(8) } }], { artifactRoot: root });
  assert.equal(v.verdict, 'BLOCKED');
  assert.equal(v.results[0].status, 'FAIL');
});

test('path escape outside artifact root is blocked', () => {
  const v = verifyDelivery([{ id: 'r1', text: 'x', check: { type: 'file_exists', path: '../../../etc/passwd' } }], { artifactRoot: root });
  assert.equal(v.verdict, 'BLOCKED');
  assert.equal(v.results[0].status, 'UNMAPPED');
  assert.match(v.results[0].reason, /escapes artifact root/);
});

test('test_run executes the suite itself and passes on the fixture', () => {
  const v = verifyDelivery([{ id: 'r1', text: 'x', check: { type: 'test_run' } }], { artifactRoot: root });
  assert.equal(v.verdict, 'PASS');
  assert.match(v.results[0].reason, /tests passing \(executed by verifier\)/);
});

test('test_run detects a failing suite', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-hsp-fail-'));
  fs.writeFileSync(path.join(tmp, 'x.test.js'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('fails', () => assert.equal(1, 2));\n");
  const v = verifyDelivery([{ id: 'r1', text: 'x', check: { type: 'test_run' } }], { artifactRoot: tmp });
  assert.equal(v.verdict, 'BLOCKED');
  assert.equal(v.results[0].status, 'FAIL');
});

test('unknown check types and missing checks are UNMAPPED and block', () => {
  const v = verifyDelivery([
    { id: 'r1', text: 'x', check: { type: 'worker_says_passed', passed: 99 } },
    { id: 'r2', text: 'y' },
  ], { artifactRoot: root });
  assert.equal(v.verdict, 'BLOCKED');
  assert.equal(v.results[0].status, 'UNMAPPED');
  assert.equal(v.results[1].status, 'UNMAPPED');
});

test('empty requirements or missing artifact root block', () => {
  assert.equal(verifyDelivery([], { artifactRoot: root }).verdict, 'BLOCKED');
  assert.equal(verifyDelivery([{ id: 'r', text: 'x', check: { type: 'file_exists', path: 'DELIVERABLE.md' } }], {}).verdict, 'BLOCKED');
});
