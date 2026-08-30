export const QIXI_LAUNCH_POPUP_SEEN_KEY = 'sullyos_qixi_2026_08_19_popup_seen';

export interface QixiLaunchPopupStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

const beijingDateParts = (now: Date): { year: number; month: number; day: number } => {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(now);
        const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
        const year = read('year');
        const month = read('month');
        const day = read('day');
        if (year && month && day) return { year, month, day };
    } catch { /* Old WebViews fall back to the fixed UTC+8 calculation below. */ }

    const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    return {
        year: utc8.getUTCFullYear(),
        month: utc8.getUTCMonth() + 1,
        day: utc8.getUTCDate(),
    };
};

export const isQixiLaunchPopupDay = (now: Date = new Date()): boolean => {
    const { year, month, day } = beijingDateParts(now);
    return year === 2026 && month === 8 && day === 19;
};

const browserStorage = (): QixiLaunchPopupStorage | null => {
    if (typeof window === 'undefined') return null;
    try {
        return window.localStorage;
    } catch {
        return null;
    }
};

export const shouldShowQixiLaunchPopup = (
    now: Date = new Date(),
    storage: QixiLaunchPopupStorage | null = browserStorage(),
): boolean => {
    if (!isQixiLaunchPopupDay(now) || !storage) return false;
    try {
        return !storage.getItem(QIXI_LAUNCH_POPUP_SEEN_KEY);
    } catch {
        // If persistence is unavailable, avoid showing the same one-time push every boot.
        return false;
    }
};

export const markQixiLaunchPopupSeen = (
    storage: QixiLaunchPopupStorage | null = browserStorage(),
): boolean => {
    if (!storage) return false;
    try {
        storage.setItem(QIXI_LAUNCH_POPUP_SEEN_KEY, '1');
        return true;
    } catch {
        return false;
    }
};
