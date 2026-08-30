import type { APIConfig } from '../types';
import { normalizeApiConfig } from './apiConfigNormalize';

const STORAGE_KEY = 'check_phone_api';

/** 查手机 App 独立 API；null 表示跟随聊天默认。 */
export function getCheckPhoneApi(): APIConfig | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = normalizeApiConfig(JSON.parse(raw) as APIConfig);
        return parsed.baseUrl ? parsed : null;
    } catch {
        return null;
    }
}

export function setCheckPhoneApi(config: APIConfig | null): void {
    try {
        if (!config?.baseUrl) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeApiConfig(config)));
        window.dispatchEvent(new CustomEvent('check-phone-api-changed'));
    } catch { /* localStorage may be unavailable in private/restricted contexts */ }
}

export function resolveCheckPhoneApi(independent: APIConfig | null, chatDefault: APIConfig): APIConfig {
    return independent?.baseUrl ? independent : chatDefault;
}

