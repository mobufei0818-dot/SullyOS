import { describe, expect, it, vi } from 'vitest';
import {
    isQixiLaunchPopupDay,
    markQixiLaunchPopupSeen,
    QIXI_LAUNCH_POPUP_SEEN_KEY,
    QixiLaunchPopupStorage,
    shouldShowQixiLaunchPopup,
} from './qixiLaunchPopup';

const createStorage = (): QixiLaunchPopupStorage & { values: Map<string, string> } => {
    const values = new Map<string, string>();
    return {
        values,
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value); },
    };
};

describe('Qixi launch popup Beijing-time gate', () => {
    it.each([
        ['one second before Beijing midnight', '2026-08-18T15:59:59.000Z', false],
        ['Beijing midnight', '2026-08-18T16:00:00.000Z', true],
        ['last second of the Beijing date', '2026-08-19T15:59:59.000Z', true],
        ['next Beijing midnight', '2026-08-19T16:00:00.000Z', false],
    ])('%s', (_label, iso, expected) => {
        expect(isQixiLaunchPopupDay(new Date(iso))).toBe(expected);
    });

    it('shows once on the target date and stays dismissed after marking seen', () => {
        const storage = createStorage();
        const now = new Date('2026-08-19T02:30:00.000Z');
        expect(shouldShowQixiLaunchPopup(now, storage)).toBe(true);
        expect(markQixiLaunchPopupSeen(storage)).toBe(true);
        expect(storage.values.get(QIXI_LAUNCH_POPUP_SEEN_KEY)).toBe('1');
        expect(shouldShowQixiLaunchPopup(now, storage)).toBe(false);
    });

    it('fails closed when storage cannot persist the one-time state', () => {
        const storage: QixiLaunchPopupStorage = {
            getItem: vi.fn(() => { throw new Error('blocked'); }),
            setItem: vi.fn(() => { throw new Error('blocked'); }),
        };
        const now = new Date('2026-08-19T02:30:00.000Z');
        expect(shouldShowQixiLaunchPopup(now, storage)).toBe(false);
        expect(markQixiLaunchPopupSeen(storage)).toBe(false);
    });
});
