import type { XhsMcpConfig } from '../types';

export type XhsDeploymentMode = 'local' | 'lite';

const normalizeUrl = (value: string): string => value.trim().replace(/\/+$/, '').toLowerCase();

/**
 * Deployment mode is not the same thing as wire protocol:
 * - local MCP uses JSON-RPC at /mcp;
 * - local Skills and cloud Lite both use the bridge REST contract at /api.
 *
 * New configs persist an explicit mode. For old configs, a stored Lite cookie or
 * the current project Worker URL identifies Lite; every other custom URL is kept
 * as local so opening Settings never silently replaces a user's server.
 */
export const resolveXhsDeploymentMode = (
    config: Pick<XhsMcpConfig, 'mode' | 'serverUrl' | 'cookie'> | undefined,
    currentLiteUrl: string,
): XhsDeploymentMode => {
    if (config?.mode === 'local' || config?.mode === 'lite') return config.mode;

    const serverUrl = normalizeUrl(config?.serverUrl || '');
    if (!serverUrl) return 'lite';
    if (config?.cookie?.trim()) return 'lite';
    return serverUrl === normalizeUrl(currentLiteUrl) ? 'lite' : 'local';
};
