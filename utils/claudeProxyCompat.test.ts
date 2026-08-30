import { describe, expect, it } from 'vitest';
import {
  buildClaudeProxyCompatibilityBody,
  shouldRetryClaudeProxyCompatibility,
} from './claudeProxyCompat';

const body = {
  model: '[千岛-AWS]claude-opus-4-6',
  messages: [
    { role: 'system', content: 'stable' },
    { role: 'user', content: 'hello' },
    { role: 'system', content: 'timely' },
  ],
  tools: [{ type: 'function', function: { name: 'schedule_active_message' } }],
  thinking: { type: 'enabled', budget_tokens: 4000 },
  reasoning_effort: 'medium',
  extra_body: { thinking: { type: 'enabled', budget_tokens: 4000 } },
};

describe('Claude relay compatibility retry', () => {
  it('recognizes the opaque Claude + tools + thinking 502', () => {
    expect(shouldRetryClaudeProxyCompatibility(new Error('API Error 502: 项目1'), body)).toBe(true);
    expect(shouldRetryClaudeProxyCompatibility(new Error('API Error 401: bad key'), body)).toBe(false);
    expect(shouldRetryClaudeProxyCompatibility(new Error('API Error 502: upstream'), { ...body, tools: [] })).toBe(false);
  });

  it('merges system messages and strips thinking dialects without dropping tools', () => {
    const fallback = buildClaudeProxyCompatibilityBody(body);
    expect(fallback.messages).toEqual([
      { role: 'system', content: 'stable\n\ntimely' },
      { role: 'user', content: 'hello' },
    ]);
    expect(fallback.tools).toEqual(body.tools);
    expect(fallback).not.toHaveProperty('thinking');
    expect(fallback).not.toHaveProperty('reasoning_effort');
    expect(fallback).not.toHaveProperty('extra_body');
  });
});
