import { describe, expect, it } from 'vitest';
import { isBenignApplicationConsoleMessage } from './applicationConsole';

describe('application console classification', () => {
  it('recognizes the TensorFlow Lite XNNPACK startup line as informational', () => {
    expect(isBenignApplicationConsoleMessage('INFO: Created TensorFlow Lite XNNPACK delegate for CPU.')).toBe(true);
    expect(isBenignApplicationConsoleMessage(' INFO:   Created TensorFlow Lite XNNPACK delegate for CPU ')).toBe(true);
  });

  it('does not hide real TensorFlow or application failures', () => {
    expect(isBenignApplicationConsoleMessage('ERROR: TensorFlow Lite failed to create delegate')).toBe(false);
    expect(isBenignApplicationConsoleMessage('ReferenceError: runMemoryPalacePostHook is not defined')).toBe(false);
  });
});
