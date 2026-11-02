import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// BUYER-declared acceptance suite for the compute job (audio transcode).
// Executed by the buyer-side verifier via the verifier's own test_run gate;
// the provider agent never runs or reports these checks.
// Requires ffprobe on PATH in the verification environment.

const probe = (file) => {
  const res = spawnSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' });
  assert.equal(res.status, 0, `ffprobe failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
};

test('transcode output meets the agreed acceptance properties', () => {
  const info = probe(new URL('./OUTPUT.opus', import.meta.url).pathname);
  const stream = info.streams.find((s) => s.codec_type === 'audio');
  assert.ok(stream, 'no audio stream');
  assert.equal(stream.codec_name, 'opus');
  assert.equal(Number(stream.sample_rate), 48000);
  assert.equal(stream.channels, 1);
  const duration = Number(info.format.duration);
  assert.ok(Math.abs(duration - 5.0) < 0.6, `duration ${duration}s outside 5.0s +/- 0.6s`);
});
