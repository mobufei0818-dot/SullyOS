import { describe, expect, it } from 'vitest';
import { getImageGenerationProviderDrafts, isImageGenerationConfigured } from './imageGeneration';
import type { APIConfig } from '../types';

const apiConfig = (imageGeneration: APIConfig['imageGeneration']): APIConfig => ({
  baseUrl: '', apiKey: '', imageGeneration,
});

describe('image generation provider settings', () => {
  it('keeps OpenAI-compatible and NovelAI credentials isolated', () => {
    const drafts = getImageGenerationProviderDrafts({
      provider: 'novelai',
      apiKey: 'active-novel-key',
      model: 'active-novel-model',
      openaiCompatible: { baseUrl: 'https://open.example/v1', apiKey: 'open-key', model: 'open-model' },
      novelai: { apiKey: 'novel-key', model: 'novel-model' },
    });
    expect(drafts.openaiCompatible).toEqual({
      baseUrl: 'https://open.example/v1', apiKey: 'open-key', model: 'open-model',
    });
    expect(drafts.novelai).toEqual({ apiKey: 'novel-key', model: 'novel-model' });
  });

  it('migrates legacy shared values only into the previously selected provider', () => {
    expect(getImageGenerationProviderDrafts({
      provider: 'novelai', apiKey: 'legacy-novel-key', model: 'legacy-novel-model',
    })).toEqual({
      openaiCompatible: { baseUrl: '', apiKey: '', model: '' },
      novelai: { apiKey: 'legacy-novel-key', model: 'legacy-novel-model' },
    });
  });

  it('does not treat either provider as configured until the user chooses a model', () => {
    expect(isImageGenerationConfigured(apiConfig({ provider: 'novelai', apiKey: 'novel-key', model: '' }))).toBe(false);
    expect(isImageGenerationConfigured(apiConfig({ provider: 'openai_compatible', baseUrl: 'https://open.example/v1', apiKey: 'open-key', model: '' }))).toBe(false);
  });

  it('removes the old automatically prefilled gpt-image-2 value', () => {
    expect(getImageGenerationProviderDrafts({
      provider: 'openai_compatible', baseUrl: 'https://open.example/v1', apiKey: 'open-key', model: 'gpt-image-2',
    }).openaiCompatible.model).toBe('');
    expect(getImageGenerationProviderDrafts({
      provider: 'novelai', apiKey: 'novel-key', model: 'gpt-image-2',
    }).novelai.model).toBe('');
  });
});
