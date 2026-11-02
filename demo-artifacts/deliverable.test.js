import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const content = fs.readFileSync(new URL('./DELIVERABLE.md', import.meta.url), 'utf8');

test('deliverable covers the Track 2 topic', () => {
  assert.match(content, /Track 2/);
});

test('deliverable is substantive', () => {
  assert.ok(content.length > 200, 'article body too short');
});
