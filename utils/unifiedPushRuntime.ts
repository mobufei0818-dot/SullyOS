import { ingestNativeAmsgPayload, parseNativeAmsgPayload } from './nativeAmsgInbox';
import { addUnifiedPushListener, drainUnifiedPushMessages, isUnifiedPushPlatform } from './unifiedPushPlugin';

let initialized = false;

const ingest = async (payload: unknown, openAfter = false): Promise<void> => {
  const result = await ingestNativeAmsgPayload(payload);
  if (openAfter && result?.charId) {
    window.dispatchEvent(new CustomEvent('active-msg-open', { detail: { charId: result.charId } }));
  }
};

export const initUnifiedPushRuntime = async (): Promise<void> => {
  if (initialized || !isUnifiedPushPlatform()) return;
  initialized = true;

  await addUnifiedPushListener('pushReceived', (event) => {
    void ingest(event?.payload);
  });
  await addUnifiedPushListener('notificationTapped', (event) => {
    void ingest(event?.payload, true);
  });

  const pending = await drainUnifiedPushMessages();
  for (const message of pending.messages || []) {
    await ingest(message.payload);
  }

  if (pending.launchPayload) {
    const payload = parseNativeAmsgPayload(pending.launchPayload);
    const charId = payload?.metadata?.charId;
    if (typeof charId === 'string' && charId) {
      window.dispatchEvent(new CustomEvent('active-msg-open', { detail: { charId } }));
    }
  }
};
