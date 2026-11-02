import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256hex } from './mandates.js';

// Delivery verification gate (BountyPilot-style): a payout is only ever
// constructed after every requirement is proven by a check THIS VERIFIER
// EXECUTES. Worker-supplied booleans, pass counts, or attestations are never
// accepted as evidence - the gate runs the evidence itself, so a worker agent
// cannot self-attest its way into a payout.
//
// Bounded by design:
//  - whitelisted check types only (unknown -> UNMAPPED -> BLOCKED);
//  - every path is confined to artifactRoot (escapes -> UNMAPPED);
//  - test_run executes exactly `node --test` (fixed argv, no shell) with cwd
//    confined to artifactRoot and a 30s timeout. It does not run arbitrary
//    worker-supplied commands.

function confinedPath(artifactRoot, p) {
  const root = path.resolve(artifactRoot);
  const full = path.resolve(root, String(p));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

function runCheck(check, artifactRoot) {
  const root = path.resolve(artifactRoot);
  switch (check.type) {
    case 'file_exists': {
      const full = confinedPath(root, check.path);
      if (!full) return { status: 'UNMAPPED', reason: `path escapes artifact root: ${check.path}` };
      return fs.existsSync(full)
        ? { status: 'PASS', reason: `file present: ${check.path}` }
        : { status: 'FAIL', reason: `missing file: ${check.path}` };
    }
    case 'file_hash': {
      const full = confinedPath(root, check.path);
      if (!full) return { status: 'UNMAPPED', reason: `path escapes artifact root: ${check.path}` };
      if (!fs.existsSync(full)) return { status: 'FAIL', reason: `missing file: ${check.path}` };
      const actual = sha256hex(fs.readFileSync(full));
      return actual === String(check.sha256).toLowerCase()
        ? { status: 'PASS', reason: `sha256 match: ${check.path}` }
        : { status: 'FAIL', reason: `sha256 mismatch on ${check.path} (expected ${check.sha256}, got ${actual})` };
    }
    case 'text_present': {
      const full = confinedPath(root, check.path);
      if (!full) return { status: 'UNMAPPED', reason: `path escapes artifact root: ${check.path}` };
      if (!fs.existsSync(full)) return { status: 'FAIL', reason: `missing file: ${check.path}` };
      const content = fs.readFileSync(full, 'utf8');
      return content.includes(check.text)
        ? { status: 'PASS', reason: `required text found in ${check.path}` }
        : { status: 'FAIL', reason: `required text absent in ${check.path}` };
    }
    case 'test_run': {
      // Strip NODE_TEST_CONTEXT so a nested `node --test` really runs when the
      // verifier itself is invoked from inside a test run.
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const res = spawnSync('node', ['--test'], { cwd: root, timeout: 30000, encoding: 'utf8', env });
      if (res.error) return { status: 'FAIL', reason: `test run failed to execute: ${res.error.message}` };
      const out = `${res.stdout || ''}\n${res.stderr || ''}`;
      const pass = Number(/# pass (\d+)/.exec(out)?.[1] ?? 0);
      const fail = Number(/# fail (\d+)/.exec(out)?.[1] ?? 0);
      if (res.status === 0 && fail === 0 && pass > 0) return { status: 'PASS', reason: `${pass} tests passing (executed by verifier)` };
      return { status: 'FAIL', reason: `test run: ${pass} pass / ${fail} fail, exit ${res.status}` };
    }
    default:
      return { status: 'UNMAPPED', reason: `unknown check type: ${check.type}` };
  }
}

// requirements: [{ id, text, check: {type, ...} }] - declared by the BUYER in
// the brief. artifactRoot: the controlled local directory holding the
// delivered artifacts.
export function verifyDelivery(requirements, { artifactRoot } = {}) {
  if (!Array.isArray(requirements) || requirements.length === 0) {
    return { verdict: 'BLOCKED', results: [], reason: 'no requirements supplied' };
  }
  if (!artifactRoot || !fs.existsSync(path.resolve(artifactRoot))) {
    return { verdict: 'BLOCKED', results: [], reason: 'artifact root missing' };
  }
  const results = requirements.map((req) => {
    if (!req.check) return { requirement: req, status: 'UNMAPPED', reason: 'no check declared for this requirement' };
    const r = runCheck(req.check, artifactRoot);
    return { requirement: req, ...r };
  });
  const blocked = results.some((r) => r.status !== 'PASS');
  return { verdict: blocked ? 'BLOCKED' : 'PASS', results };
}
