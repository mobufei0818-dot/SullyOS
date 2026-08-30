import { useEffect, useState } from 'react';
import { FloppyDisk, Plus, X } from '@phosphor-icons/react';
import { createTakeoutAddress, resolveTakeoutAddress, testAmapPoi } from '../../utils/takeoutAddressBook';
import type { TakeoutAddress, TakeoutAddressBook } from '../../utils/takeoutAddressBook';

type Recipient = { kind: 'user' } | { kind: 'character'; characterId: string };
type Character = { id: string; name: string };
type Props = { book: TakeoutAddressBook; recipient: Recipient; characters: Character[]; onRecipientChange: (recipient: Recipient) => void; onChange: (book: TakeoutAddressBook) => void; onClose: () => void; addToast: (message: string, type: 'success' | 'error' | 'info') => void };

const focusInput = (event: React.FocusEvent<HTMLInputElement>) => window.setTimeout(() => event.currentTarget.scrollIntoView({ behavior: 'smooth', block: 'center' }), 180);

export default function TakeoutAddressSettings({ book, recipient, characters, onRecipientChange, onChange, onClose, addToast }: Props) {
  // The overlay is mounted above the app, so it holds a responsive local view and mirrors changes back to TakeoutApp.
  const [localBook, setLocalBook] = useState(book);
  const [activeRecipient, setActiveRecipient] = useState<Recipient>(recipient);
  const current = resolveTakeoutAddress(localBook, activeRecipient);
  const [draft, setDraft] = useState<TakeoutAddress>(current);
  const [testing, setTesting] = useState(false);
  const commit = (next: TakeoutAddressBook) => { setLocalBook(next); onChange(next); };
  const switchRecipient = (next: Recipient) => { setActiveRecipient(next); setDraft(resolveTakeoutAddress(localBook, next)); onRecipientChange(next); };
  useEffect(() => { setDraft(resolveTakeoutAddress(localBook, activeRecipient)); }, [activeRecipient, current.id]);
  const selectEntry = (id: string) => {
    const entry = localBook.entries.find(item => item.id === id) || current;
    setDraft(entry);
    commit(activeRecipient.kind === 'user' ? { ...localBook, userAddressId: id } : { ...localBook, characterAddressIds: { ...localBook.characterAddressIds, [activeRecipient.characterId]: id } });
  };
  const saveCurrent = () => {
    const normalized = { ...draft, name: draft.name.trim() || '未命名地址', address: draft.address.trim(), mappedAddress: draft.mappedAddress.trim() || draft.address.trim() };
    const exists = localBook.entries.some(item => item.id === normalized.id);
    const entry = exists ? normalized : createTakeoutAddress(normalized);
    const entries = exists ? localBook.entries.map(item => item.id === entry.id ? entry : item) : [...localBook.entries, entry];
    commit(activeRecipient.kind === 'user' ? { ...localBook, entries, userAddressId: entry.id } : { ...localBook, entries, characterAddressIds: { ...localBook.characterAddressIds, [activeRecipient.characterId]: entry.id } });
    setDraft(entry); addToast('地址已保存并绑定到当前收货人', 'success');
  };
  const test = async () => {
    setTesting(true);
    const result = await testAmapPoi(localBook.amapKey, draft);
    commit({ ...localBook, lastPoiTest: { ...result, at: Date.now() } });
    addToast(result.message, result.success ? 'success' : 'error'); setTesting(false);
  };
  return <div className="fixed inset-0 z-40 flex items-end bg-black/35"><div className="max-h-[92dvh] w-full space-y-3 overflow-y-auto overscroll-contain rounded-t-3xl bg-white p-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))]"><button className="float-right" onClick={onClose}><X/></button><h2 className="text-xl font-bold">收货地址与高德 POI</h2><p className="text-xs text-slate-500">地址按用户和角色分别保存；切换对象会立即载入其已绑定地址。</p><div className="flex gap-2 overflow-x-auto pb-2 text-sm"><button onClick={()=>switchRecipient({kind:'user'})} className={`shrink-0 rounded-2xl px-4 py-3 ${activeRecipient.kind==='user'?'bg-orange-500 text-white':'bg-slate-100'}`}>用户地址</button>{characters.map(character=><button key={character.id} onClick={()=>switchRecipient({kind:'character',characterId:character.id})} className={`shrink-0 rounded-2xl px-4 py-3 ${activeRecipient.kind==='character'&&activeRecipient.characterId===character.id?'bg-orange-500 text-white':'bg-slate-100'}`}>{character.name}</button>)}</div><label className="block text-sm">已保存地址<select value={current.id} onChange={event=>selectEntry(event.target.value)} className="mt-1 w-full rounded-xl bg-slate-100 px-3 py-3 outline-none">{localBook.entries.map(entry=><option key={entry.id} value={entry.id}>{entry.name} · {entry.address}</option>)}</select></label><button onClick={()=>setDraft(createTakeoutAddress({ name: '', mode: 'virtual', address: '', mappedAddress: '' }))} className="flex items-center gap-1 text-sm text-orange-600"><Plus/>新增地址</button><label className="block text-sm">地址名称<input value={draft.name} onFocus={focusInput} onChange={event=>setDraft(value=>({...value,name:event.target.value}))} placeholder="例如：谢俞家 / 学校 / 我家" className="mt-1 w-full rounded-xl bg-slate-100 px-3 py-3 outline-none"/></label><label className="block text-sm">显示收货地址<input value={draft.address} onFocus={focusInput} onChange={event=>setDraft(value=>({...value,address:event.target.value}))} placeholder="例如：上海静安区" className="mt-1 w-full rounded-xl bg-slate-100 px-3 py-3 outline-none"/></label><div className="flex gap-2 text-sm"><button onClick={()=>setDraft(value=>({...value,mode:'real'}))} className={`rounded-lg px-3 py-2 ${draft.mode==='real'?'bg-orange-500 text-white':'bg-slate-100'}`}>真实地址</button><button onClick={()=>setDraft(value=>({...value,mode:'virtual'}))} className={`rounded-lg px-3 py-2 ${draft.mode==='virtual'?'bg-orange-500 text-white':'bg-slate-100'}`}>虚拟地址</button></div>{draft.mode==='virtual' && <label className="block text-sm">映射真实地点（高德查询用）<input value={draft.mappedAddress} onFocus={focusInput} onChange={event=>setDraft(value=>({...value,mappedAddress:event.target.value}))} placeholder="例如：上海市静安区" className="mt-1 w-full rounded-xl bg-slate-100 px-3 py-3 outline-none"/></label>}<label className="block text-sm">高德 Web 服务 Key<input type="password" value={localBook.amapKey} onFocus={focusInput} onChange={event=>commit({...localBook,amapKey:event.target.value})} placeholder="仅保存在本机浏览器" className="mt-1 w-full rounded-xl bg-slate-100 px-3 py-3 outline-none"/></label><div className="flex gap-2"><button onClick={test} disabled={testing} className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold disabled:opacity-50">{testing?'正在测试…':'测试 POI 连接'}</button><button onClick={saveCurrent} className="flex-1 rounded-xl bg-orange-500 py-3 text-sm font-bold text-white"><FloppyDisk className="mr-1 inline"/>保存当前地址</button></div>{localBook.lastPoiTest && <div className={`rounded-xl p-3 text-xs ${localBook.lastPoiTest.success?'bg-emerald-50 text-emerald-800':'bg-red-50 text-red-700'}`}><b>{localBook.lastPoiTest.success?'高德 POI 可用':'高德 POI 未通过'}</b><p className="mt-1">{localBook.lastPoiTest.message}</p>{localBook.lastPoiTest.poiNames?.length ? <p className="mt-1">示例：{localBook.lastPoiTest.poiNames.join('、')}</p> : null}</div>}<p className="text-xs text-slate-500">请使用高德控制台创建的「Web 服务」Key。每次外卖刷新或搜索最多查询一次 POI；若测试失败，刷新仍会照常调用你的外卖 AI，但不会使用附近店铺信息。</p></div></div>;
}
