export const BROWSER_BACK_GUARD_KEY = '__sullyOSBrowserBackGuardV1';

type HistoryStateRecord = Record<string, unknown>;

const asHistoryStateRecord = (state: unknown): HistoryStateRecord => (
    state !== null && typeof state === 'object' && !Array.isArray(state)
        ? state as HistoryStateRecord
        : {}
);

export const isBrowserBackGuardState = (state: unknown): boolean => (
    asHistoryStateRecord(state)[BROWSER_BACK_GUARD_KEY] === true
);

export const makeBrowserBackGuardState = (state: unknown): HistoryStateRecord => ({
    ...asHistoryStateRecord(state),
    [BROWSER_BACK_GUARD_KEY]: true,
});
