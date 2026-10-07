/**
 * Pure-JS SHA-256 evidence (C1 gate #6): known standard vectors plus a
 * cross-check against Node's own crypto across boundary-length and
 * multi-byte inputs. The event-id encoder's compressed lane (`ev:<digest>`)
 * inherits its collision resistance from exactly this implementation.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { sha256Hex } from '@/lib/utils/sha256';

describe('sha256Hex — standard vectors (FIPS 180-4 / well-known)', () => {
  it('matches the published digests', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('agrees with node:crypto across padding boundaries and multi-byte input', () => {
    const cases = [
      ...Array.from({ length: 14 }, (_, i) => 'a'.repeat(51 + i)), // 51..64-byte boundary
      ...Array.from({ length: 6 }, (_, i) => 'a'.repeat(119 + i)), // 119..124-byte boundary
      '中文错题',
      '数学-émoji-🌍',
      JSON.stringify(['att'.repeat(80), 'q-长']),
    ];
    for (const input of cases) {
      expect(sha256Hex(input)).toBe(createHash('sha256').update(input, 'utf8').digest('hex'));
    }
  });
});
