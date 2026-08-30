export type CompanionLayoutId = 'stage';

export type CompanionLayoutOption = {
  id: CompanionLayoutId;
  name: string;
  description: string;
};

export const COMPANION_LAYOUT_KEY = 'companion_layout_v1';
export const COMPANION_LAYOUT_EVENT = 'sullyos:companion-layout';

export const COMPANION_LAYOUTS: CompanionLayoutOption[] = [
  { id: 'stage', name: '舞台', description: '角色居中，功能环绕的原始桌面' },
];

const isCompanionLayout = (value: string | null): value is CompanionLayoutId => (
  COMPANION_LAYOUTS.some(layout => layout.id === value)
);

export const loadCompanionLayout = (): CompanionLayoutId => {
  if (typeof window === 'undefined') return 'stage';
  try {
    const stored = window.localStorage.getItem(COMPANION_LAYOUT_KEY);
    return isCompanionLayout(stored) ? stored : 'stage';
  } catch {
    return 'stage';
  }
};

export const saveCompanionLayout = (layout: CompanionLayoutId): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COMPANION_LAYOUT_KEY, layout);
  } catch {
    // Private WebViews can reject storage; the current screen still updates.
  }
  window.dispatchEvent(new CustomEvent<CompanionLayoutId>(COMPANION_LAYOUT_EVENT, { detail: layout }));
};
