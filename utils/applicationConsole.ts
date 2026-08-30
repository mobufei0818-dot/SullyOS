const TFLITE_XNNPACK_INFO = /^INFO:\s*Created TensorFlow Lite XNNPACK delegate for CPU\.?\s*$/i;

/** Native/WASM runtimes sometimes send informational stderr through console.error. */
export const isBenignApplicationConsoleMessage = (message: string): boolean => (
  TFLITE_XNNPACK_INFO.test(String(message || '').trim())
);
