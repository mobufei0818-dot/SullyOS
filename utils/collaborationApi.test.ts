import { describe, expect, it, vi } from 'vitest';
import type { APIConfig, ApiPreset } from '../types';
import {
  fetchCollaborationModels,
  hydrateCollaborationApiSettings,
} from '../features/collaboration/api';
import type { CollaborationSettings } from '../features/collaboration/types';
import { EMPTY_COLLABORATION_API_PROFILE } from '../features/collaboration/types';

const chatApi: APIConfig = {
  baseUrl: 'https://chat.example.com/v1',
  apiKey: 'saved-chat-key',
  model: 'chat-model',
  stream: false,
  temperature: 0.85,
};

const settings = (overrides: Partial<CollaborationSettings> = {}): CollaborationSettings => ({
  id: 'main',
  immersive: { ...EMPTY_COLLABORATION_API_PROFILE },
  focused: { ...EMPTY_COLLABORATION_API_PROFILE },
  updatedAt: 0,
  ...overrides,
});

describe('collaboration API selection', () => {
  it('defaults blank modes to the API and model already used by ChatApp', () => {
    const hydrated = hydrateCollaborationApiSettings(settings(), chatApi, []);
    expect(hydrated.immersive).toMatchObject({
      baseUrl: chatApi.baseUrl,
      apiKey: chatApi.apiKey,
      model: chatApi.model,
      source: 'chat',
      sourceName: '当前 ChatApp',
    });
    expect(hydrated.focused.model).toBe('chat-model');
  });

  it('keeps legacy non-empty collaboration credentials as a custom connection', () => {
    const hydrated = hydrateCollaborationApiSettings(settings({
      immersive: {
        ...EMPTY_COLLABORATION_API_PROFILE,
        baseUrl: 'https://custom.example/v1',
        apiKey: 'custom-key',
        model: 'custom-model',
      },
    }), chatApi, []);
    expect(hydrated.immersive).toMatchObject({
      baseUrl: 'https://custom.example/v1',
      model: 'custom-model',
      source: 'custom',
    });
  });

  it('refreshes a linked preset without losing collaboration stream settings', () => {
    const presets: ApiPreset[] = [{ id: 'preset-1', name: '工作站', config: { ...chatApi, apiKey: 'new-key', model: 'new-model' } }];
    const hydrated = hydrateCollaborationApiSettings(settings({
      focused: {
        ...EMPTY_COLLABORATION_API_PROFILE,
        source: 'preset',
        sourceId: 'preset-1',
        sourceName: '工作站',
        stream: true,
        temperature: 0.35,
      },
    }), chatApi, presets);
    expect(hydrated.focused).toMatchObject({
      apiKey: 'new-key',
      model: 'new-model',
      stream: true,
      temperature: 0.35,
      source: 'preset',
    });
  });

  it('fetches common OpenAI-compatible model lists with the saved key', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ data: { models: [{ model_name: 'alpha' }, { id: 'beta' }] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
    const models = await fetchCollaborationModels({ baseUrl: 'https://api.example/v1/', apiKey: 'remembered-key' }, request);
    expect(models).toEqual(['alpha', 'beta']);
    expect(request).toHaveBeenCalledWith('https://api.example/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer remembered-key' }),
    }));
  });
});
