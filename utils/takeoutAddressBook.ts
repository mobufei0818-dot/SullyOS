export type TakeoutAddressMode = 'real' | 'virtual';

export type TakeoutAddress = {
  id: string;
  name: string;
  mode: TakeoutAddressMode;
  address: string;
  mappedAddress: string;
  createdAt: number;
};

export type TakeoutAddressBook = {
  version: 1;
  entries: TakeoutAddress[];
  userAddressId?: string;
  characterAddressIds: Record<string, string>;
  amapKey: string;
  lastPoiTest?: { success: boolean; at: number; message: string; poiNames?: string[] };
};

const STORAGE_KEY = 'nmj-takeout-address-book-v1';
const LEGACY_KEY = 'nmj-takeout-location';

const fallbackAddress = (): TakeoutAddress => ({ id: 'default-address', name: '默认地址', mode: 'virtual', address: '上海静安区', mappedAddress: '上海市静安区', createdAt: Date.now() });

export function loadTakeoutAddressBook(): TakeoutAddressBook {
  if (typeof localStorage === 'undefined') return { version: 1, entries: [fallbackAddress()], userAddressId: 'default-address', characterAddressIds: {}, amapKey: '' };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved?.version === 1 && Array.isArray(saved.entries)) return { version: 1, entries: saved.entries, userAddressId: saved.userAddressId, characterAddressIds: saved.characterAddressIds || {}, amapKey: saved.amapKey || '', lastPoiTest: saved.lastPoiTest };
  } catch { /* migrate the prior one-field setup below */ }
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}');
    const migrated: TakeoutAddress = { id: 'legacy-default-address', name: '原有默认地址', mode: legacy.mode === 'real' ? 'real' : 'virtual', address: legacy.address || '上海静安区', mappedAddress: legacy.mappedAddress || legacy.address || '上海市静安区', createdAt: Date.now() };
    return { version: 1, entries: [migrated], userAddressId: migrated.id, characterAddressIds: {}, amapKey: legacy.amapKey || '' };
  } catch {
    const address = fallbackAddress();
    return { version: 1, entries: [address], userAddressId: address.id, characterAddressIds: {}, amapKey: '' };
  }
}

export function persistTakeoutAddressBook(book: TakeoutAddressBook): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(book));
}

export function resolveTakeoutAddress(book: TakeoutAddressBook, target: { kind: 'user' } | { kind: 'character'; characterId: string }): TakeoutAddress {
  const id = target.kind === 'user' ? book.userAddressId : book.characterAddressIds[target.characterId];
  return book.entries.find(entry => entry.id === id) || book.entries[0] || fallbackAddress();
}

export function createTakeoutAddress(values: Omit<TakeoutAddress, 'id' | 'createdAt'>): TakeoutAddress {
  return { ...values, id: `takeout-address-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, createdAt: Date.now() };
}

export type PoiTestResult = { success: boolean; message: string; poiNames?: string[] };

export async function testAmapPoi(key: string, address: TakeoutAddress, keyword = '餐饮'): Promise<PoiTestResult> {
  if (!key.trim()) return { success: false, message: '请先填写高德 Web 服务 Key。' };
  const region = address.mode === 'real' ? address.address : address.mappedAddress;
  if (!region.trim()) return { success: false, message: '请先填写用于 POI 查询的地址。' };
  try {
    const response = await fetch(`https://restapi.amap.com/v5/place/text?key=${encodeURIComponent(key.trim())}&keywords=${encodeURIComponent(keyword)}&region=${encodeURIComponent(region)}&city_limit=true&page_size=10`);
    const json = await response.json();
    const success = String(json?.status) === '1' || String(json?.infocode) === '10000';
    if (!success) return { success: false, message: `高德返回 ${json?.infocode || '未知错误'}：${json?.info || '请求失败'}` };
    const names = Array.isArray(json?.pois) ? json.pois.slice(0, 5).map((poi: { name?: string }) => poi.name).filter(Boolean) : [];
    return { success: true, message: names.length ? `查询成功：在「${region}」找到 ${json.pois.length || names.length} 个结果。` : `连接成功，但「${region}」没有找到“${keyword}”相关 POI。`, poiNames: names };
  } catch (error: any) {
    return { success: false, message: `无法连接高德：${error?.message || '网络或浏览器跨域限制'}` };
  }
}
