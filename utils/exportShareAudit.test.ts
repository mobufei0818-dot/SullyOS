import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

const walk = (directory: string): string[] => readdirSync(directory).flatMap(name => {
    const path = `${directory}/${name}`;
    return statSync(path).isDirectory() ? walk(path) : [path];
});

describe('文件导出统一分享适配', () => {
    it('业务代码不再直接触发 anchor.download', () => {
        const forbidden = ['.down', 'load ='].join('');
        const sourceRoots = ['apps', 'components', 'context', 'features', 'utils'];
        const violations = sourceRoots
            .flatMap(root => walk(`${projectRoot}/${root}`))
            .filter(path => /\.(?:ts|tsx)$/.test(path))
            .filter(path => !/\.test\.(?:ts|tsx)$/.test(path))
            .filter(path => !path.endsWith('/utils/shareExport.ts'))
            .filter(path => readFileSync(path, 'utf8').includes(forbidden))
            .map(path => path.replace(projectRoot.replace(/\\/g, '/'), ''));

        expect(violations).toEqual([]);
    });

    it('大体积系统备份也复用统一分享，并开启原生分片写盘', () => {
        const settings = readFileSync(`${projectRoot}/apps/Settings.tsx`, 'utf8');
        expect(settings).toContain("import { shareOrDownloadBlob } from '../utils/shareExport'");
        expect(settings).toContain('nativeChunked: true');
        expect(settings).not.toContain('Filesystem.appendFile');
    });

    it('统一出口的顺序是原生分享、Web 文件分享、桌面下载兜底', () => {
        const source = readFileSync(`${projectRoot}/utils/shareExport.ts`, 'utf8');
        const nativeShare = source.indexOf('Capacitor.isNativePlatform()');
        const webShare = source.indexOf('navigator.share');
        const browserDownload = source.indexOf('anchor.download');

        expect(nativeShare).toBeGreaterThanOrEqual(0);
        expect(webShare).toBeGreaterThan(nativeShare);
        expect(browserDownload).toBeGreaterThan(webShare);
    });
});
