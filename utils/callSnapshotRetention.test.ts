import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { CALL_SNAPSHOT_RETAINED_ROUNDS, findExpiredCallSnapshots } from './callSnapshotRetention';

const snapshotMessage = (id: number, sessionId = 'call-a'): Message => ({
  id,
  charId: 'char-a',
  role: 'user',
  type: 'text',
  content: `turn-${id}`,
  timestamp: id * 100,
  metadata: {
    source: 'call',
    callSessionId: sessionId,
    cameraSnapshotRef: `blobref:snapshot-${id}`,
  },
});

describe('call snapshot retention', () => {
  it('keeps the newest three snapshots and expires older frames', () => {
    const expired = findExpiredCallSnapshots([
      snapshotMessage(1),
      snapshotMessage(2),
      snapshotMessage(3),
      snapshotMessage(4),
      snapshotMessage(5),
    ], 'call-a');

    expect(CALL_SNAPSHOT_RETAINED_ROUNDS).toBe(3);
    expect(expired).toEqual([
      { messageId: 2, ref: 'blobref:snapshot-2' },
      { messageId: 1, ref: 'blobref:snapshot-1' },
    ]);
  });

  it('does not count another session or non-user messages', () => {
    const assistant = { ...snapshotMessage(9), role: 'assistant' as const };
    const expired = findExpiredCallSnapshots([
      snapshotMessage(1),
      snapshotMessage(2),
      snapshotMessage(3),
      snapshotMessage(4, 'call-b'),
      assistant,
    ], 'call-a');

    expect(expired).toEqual([]);
  });

  it('can expire every snapshot when explicitly asked to keep none', () => {
    expect(findExpiredCallSnapshots([snapshotMessage(1), snapshotMessage(2)], 'call-a', 0))
      .toEqual([
        { messageId: 2, ref: 'blobref:snapshot-2' },
        { messageId: 1, ref: 'blobref:snapshot-1' },
      ]);
  });
});
