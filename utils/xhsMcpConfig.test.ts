import { describe, expect, it } from 'vitest';
import { resolveXhsDeploymentMode } from './xhsMcpConfig';

const LITE_URL = 'https://worker.example/api';

describe('resolveXhsDeploymentMode', () => {
    it('honors the explicit mode written by new versions', () => {
        expect(resolveXhsDeploymentMode({ mode: 'local', serverUrl: LITE_URL }, LITE_URL)).toBe('local');
        expect(resolveXhsDeploymentMode({ mode: 'lite', serverUrl: 'http://localhost:18061/api' }, LITE_URL)).toBe('lite');
    });

    it('keeps an old local MCP URL local', () => {
        expect(resolveXhsDeploymentMode({ serverUrl: 'http://localhost:18060/mcp' }, LITE_URL)).toBe('local');
    });

    it('does not confuse an old local Skills /api URL with Lite', () => {
        expect(resolveXhsDeploymentMode({ serverUrl: 'http://localhost:18061/api' }, LITE_URL)).toBe('local');
    });

    it('recognizes the currently configured project Worker as Lite', () => {
        expect(resolveXhsDeploymentMode({ serverUrl: 'https://worker.example/api/' }, LITE_URL)).toBe('lite');
    });

    it('keeps old Lite configs recognizable when they contain a cookie', () => {
        expect(resolveXhsDeploymentMode({ serverUrl: 'https://old-worker.example/api', cookie: 'a1=abc' }, LITE_URL)).toBe('lite');
    });
});
