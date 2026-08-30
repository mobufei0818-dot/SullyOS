import { describe, expect, it } from 'vitest';
import { CollaborationStore } from '../features/collaboration/store';
import type { CollaborationMessage, CollaborationSession } from '../features/collaboration/types';
import { DEFAULT_COLLABORATION_SETTINGS } from '../features/collaboration/types';

describe('collaboration file library and backup', () => {
  it('deletes the canonical file and restores the sidecar database from backup', async () => {
    const stamp = Date.now();
    const charId = `collab-store-char-${stamp}`;
    const session: CollaborationSession = {
      id: `collab-store-session-${stamp}`,
      charId,
      title: '测试协同',
      mode: 'focused',
      createdAt: stamp,
      updatedAt: stamp,
    };
    const assetId = `collab-store-asset-${stamp}`;
    const message: CollaborationMessage = {
      id: `collab-store-message-${stamp}`,
      sessionId: session.id,
      role: 'assistant',
      content: '文件做好了。',
      createdAt: stamp,
      attachments: [{
        id: `collab-store-attachment-${stamp}`,
        assetId,
        kind: 'artifact',
        name: '测试文件.pdf',
        mimeType: 'application/pdf',
        size: 4,
        createdAt: stamp,
        format: 'pdf',
      }],
    };

    await CollaborationStore.saveSession(session);
    await CollaborationStore.saveMessage(message);
    await CollaborationStore.saveAsset({ id: assetId, blob: new Blob(['test'], { type: 'application/pdf' }), createdAt: stamp });
    await CollaborationStore.saveSettings({ ...DEFAULT_COLLABORATION_SETTINGS, updatedAt: stamp });

    const snapshot = await CollaborationStore.exportBackup(true, true);
    expect(snapshot.sessions?.some(row => row.id === session.id)).toBe(true);
    expect(snapshot.messages?.some(row => row.id === message.id)).toBe(true);
    expect(snapshot.assets?.some(row => row.id === assetId)).toBe(true);

    await CollaborationStore.deleteLibraryFile(assetId);
    expect(await CollaborationStore.getAsset(assetId)).toBeNull();
    expect((await CollaborationStore.listMessages(session.id))[0]?.attachments).toBeUndefined();
    expect(await CollaborationStore.listLibraryFiles(charId)).toEqual([]);

    await CollaborationStore.importBackup(snapshot, { replaceAssets: true });
    expect((await CollaborationStore.listSessions(charId))[0]?.id).toBe(session.id);
    expect((await CollaborationStore.listLibraryFiles(charId))[0]?.assetId).toBe(assetId);
    expect((await CollaborationStore.getAsset(assetId))?.size).toBe(4);
  });
});
