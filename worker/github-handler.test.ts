import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleGithub } from '../cloudflare/github-handler';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('GitHub Worker proxy', () => {
    it('streams the incoming upload body and exposes retry diagnostics', async () => {
        let forwardedBody: BodyInit | null | undefined;
        const upstreamFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
            forwardedBody = init?.body;
            return Promise.resolve(new Response(JSON.stringify({ message: 'slow down' }), {
                status: 429,
                headers: {
                    'Content-Type': 'application/json',
                    'Retry-After': '3',
                    'X-RateLimit-Remaining': '0',
                },
            }));
        });
        vi.stubGlobal('fetch', upstreamFetch);

        const request = new Request(
            'https://worker.example/github?url=https%3A%2F%2Fuploads.github.com%2Frepos%2Fowner%2Frepo%2Freleases%2F1%2Fassets%3Fname%3Dbackup.zip',
            {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer test',
                    'Content-Type': 'application/zip',
                    'X-GitHub-Method': 'POST',
                },
                body: new Uint8Array([1, 2, 3]),
                duplex: 'half',
            } as RequestInit,
        );
        const incomingBody = request.body;

        const response = await handleGithub(request);

        expect(upstreamFetch).toHaveBeenCalledTimes(1);
        expect(forwardedBody).toBe(incomingBody);
        expect(forwardedBody).not.toBeInstanceOf(ArrayBuffer);
        expect(response.status).toBe(429);
        expect(response.headers.get('Retry-After')).toBe('3');
        expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-RateLimit-Remaining');
    });
});
