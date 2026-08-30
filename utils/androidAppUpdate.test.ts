import { beforeEach, describe, expect, it, vi } from 'vitest';

const { filesystemMocks, installerMocks } = vi.hoisted(() => ({
  filesystemMocks: {
    mkdir: vi.fn(),
    deleteFile: vi.fn(),
    addListener: vi.fn(),
    downloadFile: vi.fn(),
    getUri: vi.fn(),
  },
  installerMocks: {
    getInstalledInfo: vi.fn(),
    verifyApk: vi.fn(),
    installApk: vi.fn(),
    openInstallPermissionSettings: vi.fn(),
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
  },
  registerPlugin: () => installerMocks,
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: filesystemMocks,
}));

import { downloadAndVerifyAndroidUpdate, parseAndroidUpdateManifest } from './androidAppUpdate';

const validManifest = {
  schemaVersion: 1,
  versionCode: 30402,
  versionName: '3.4.2',
  apkUrl: 'https://github.com/example/app/releases/download/v3.4.2/app.apk',
  sha256: 'a'.repeat(64),
  sizeBytes: 37_000_000,
  releaseNotes: ['修复更新按钮', '', 123],
};

beforeEach(() => {
  vi.clearAllMocks();
  filesystemMocks.mkdir.mockResolvedValue(undefined);
  filesystemMocks.deleteFile.mockResolvedValue(undefined);
  filesystemMocks.downloadFile.mockResolvedValue(undefined);
  filesystemMocks.getUri.mockResolvedValue({ uri: 'file:///cache/updates/SullyOS-update.apk' });
  installerMocks.verifyApk.mockResolvedValue({
    valid: true,
    packageName: 'com.aetheros.simulator',
    versionCode: validManifest.versionCode,
    versionName: validManifest.versionName,
    certificateSha256: 'b'.repeat(64),
    canRequestPackageInstalls: true,
  });
});

describe('parseAndroidUpdateManifest', () => {
  it('accepts and normalizes a valid manifest', () => {
    expect(parseAndroidUpdateManifest(validManifest)).toMatchObject({
      versionCode: 30402,
      versionName: '3.4.2',
      sha256: 'a'.repeat(64),
      releaseNotes: ['修复更新按钮'],
    });
  });

  it.each([
    ['bad schema', { ...validManifest, schemaVersion: 2 }],
    ['bad version', { ...validManifest, versionCode: 0 }],
    ['insecure url', { ...validManifest, apkUrl: 'http://example.com/app.apk' }],
    ['bad digest', { ...validManifest, sha256: 'nope' }],
    ['bad size', { ...validManifest, sizeBytes: -1 }],
  ])('rejects %s', (_name, manifest) => {
    expect(() => parseAndroidUpdateManifest(manifest)).toThrow();
  });
});

describe('downloadAndVerifyAndroidUpdate', () => {
  it('creates the nested cache directory before the first download', async () => {
    filesystemMocks.deleteFile.mockRejectedValueOnce(new Error('file does not exist'));

    await expect(downloadAndVerifyAndroidUpdate(validManifest)).resolves.toBe(
      'file:///cache/updates/SullyOS-update.apk',
    );

    expect(filesystemMocks.mkdir).toHaveBeenCalledWith({
      path: 'updates',
      directory: 'CACHE',
      recursive: true,
    });
    expect(filesystemMocks.downloadFile).toHaveBeenCalledWith(expect.objectContaining({
      url: validManifest.apkUrl,
      path: 'updates/SullyOS-update.apk',
      directory: 'CACHE',
      recursive: true,
    }));
    expect(filesystemMocks.mkdir.mock.invocationCallOrder[0]).toBeLessThan(
      filesystemMocks.downloadFile.mock.invocationCallOrder[0],
    );
  });
});
