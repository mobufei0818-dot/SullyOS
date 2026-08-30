import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve(__dirname, '../context/OSContext.tsx'), 'utf8');

describe('OSContext development HMR identity', () => {
  it('keeps the Context object stable when Vite re-evaluates the module', () => {
    expect(source).toContain('__SULLYOS_OS_CONTEXT_HMR__');
    expect(source).toMatch(/import\.meta\.env\.DEV[\s\S]*\? \(osContextHmrGlobal\.__SULLYOS_OS_CONTEXT_HMR__ \?\?=/);
  });

  it('does not leak the HMR global into the production branch', () => {
    expect(source).toMatch(/:\s*createContext<OSContextType \| undefined>\(undefined\);/);
  });
});
