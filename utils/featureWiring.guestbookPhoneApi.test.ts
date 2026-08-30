import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('留言簿定向回复接线', () => {
    it('用户回复会同时保存目标 id/name，并在输入区展示取消入口', () => {
        const source = read('apps/VRWorldApp.tsx');
        expect(source).toContain('replyToId: replyTo?.id');
        expect(source).toContain('replyToName: replyTo?.authorName');
        expect(source).toContain('onClick={() => startReply(m)}');
        expect(source).toContain('aria-label="取消回复"');
    });
});

describe('查手机独立 API 接线', () => {
    it('全部查手机生成入口统一走 effectiveApiConfig，并在选人页提供设置', () => {
        const source = read('apps/CheckPhone.tsx');
        expect(source).toContain('resolveCheckPhoneApi(phoneApiConfig, apiConfig)');
        expect(source).toContain('aria-label="查手机 API 设置"');
        expect(source).toContain('api: effectiveApiConfig as any');
        expect(source).not.toMatch(/fetch\(`\$\{apiConfig\.baseUrl/);
        expect(source).not.toContain('api: apiConfig as any');
        expect(source).not.toContain('apiConfig: apiConfig as any');
    });

    it('独立 API 会进入完整/纯文本备份并在导入时恢复', () => {
        const context = read('context/OSContext.tsx');
        const types = read('types.ts');
        expect(types).toContain('checkPhoneApi?: APIConfig | null');
        expect(context).toContain('checkPhoneApi: (mode === \'text_only\' || mode === \'full\') ? getCheckPhoneApi() : undefined');
        expect(context).toContain('setCheckPhoneApi(data.checkPhoneApi ?? null)');
    });
});
