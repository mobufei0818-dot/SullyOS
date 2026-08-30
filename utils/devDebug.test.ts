import { describe, expect, it } from 'vitest';
import { redactDevDebugSecrets } from './devDebug';

describe('dev debug privacy redaction', () => {
  it('never persists camera image data URLs in request detail logs', () => {
    expect(redactDevDebugSecrets({
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,PRIVATEPIXELS' } }],
      }],
    })).toEqual({
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: '<image data omitted · 36 chars>' } }],
      }],
    });
  });
});
