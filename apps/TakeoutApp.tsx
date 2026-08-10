import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowsClockwise, CaretRight, MagnifyingGlass, MapPin, Plus, ShoppingCartSimple, X } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { createAmsg2ToolSession, executeAmsg2Tool } from '../utils/amsg2ToolBridge';
import { safeFetchJson } from '../utils/safeApi';
import type { APIConfig } from '../types';

type Category = '美食' | '甜点饮品' | '超市便利' | '蔬菜水果' | '看病买药' | '早餐' | '拼好饭' | '跑腿';
type Item = { id: string; name: string; shop: string; price: number; desc: string; category: Category; image: string; options: string[] };
const CATEGORIES: { name: Category; icon: string; tint: string }[] = [
  { name: '美食', icon: '🍜', tint: 'bg-orange-50' }, { name: '甜点饮品', icon: '🧋', tint: 'bg-pink-50' },
  { name: '超市便利', icon: '🛒', tint: 'bg-sky-50' }, { name: '蔬菜水果', icon: '🍓', tint: 'bg-emerald-50' },
  { name: '看病买药', icon: '💊', tint: 'bg-cyan-50' }, { name: '早餐', icon: '🥪', tint: 'bg-amber-50' },
  { name: '拼好饭', icon: '🍱', tint: 'bg-red-50' }, { name: '跑腿', icon: '🛵', tint: 'bg-violet-50' },
];
const SEEDS: Record<Category, Array<[string, string, number, string, string[]]>> = {
  美食: [['招牌黄焖鸡米饭', '巷口黄焖鸡', 22, '现焖鸡腿肉，米饭免费续', ['微辣', '中辣', '特辣']], ['番茄牛肉米线', '滇味小馆', 25, '汤底酸甜，配牛肉片', ['不要香菜', '加酸笋', '加辣油']]],
  甜点饮品: [['生椰拿铁', '树夏咖啡', 19, '椰香浓郁，现萃咖啡', ['全糖', '七分糖', '三分糖', '少冰', '去冰']], ['芝芝葡萄', '茶屿', 22, '鲜果与轻芝士', ['正常冰', '少冰', '去冰', '五分糖', '无糖']]],
  超市便利: [['深夜零食补给包', '便利蜂', 28, '薯片、气泡水和巧克力', ['需要餐具', '不要餐具']], ['冰鲜纯牛奶', '邻里超市', 16, '2L 家庭装', ['冷藏配送', '常温配送']]],
  蔬菜水果: [['阳光玫瑰葡萄', '每日鲜果', 32, '精选 500g', ['帮我挑甜的', '熟一点', '普通挑选']], ['时令蔬菜组合', '菜场到家', 20, '适合两人一餐', ['切好', '整份']]],
  看病买药: [['感冒药家庭装', '安心大药房', 26, '请按说明书使用', ['需要发票', '隐私配送']], ['创可贴组合', '健康便利店', 12, '轻便防水款', ['普通包装', '隐私配送']]],
  早餐: [['豆浆油条套餐', '清晨食堂', 12, '现磨豆浆 + 油条', ['甜豆浆', '无糖豆浆', '加鸡蛋']], ['培根蛋可颂', '面包街', 18, '热压现做', ['加芝士', '不要酱']]],
  拼好饭: [['拼好饭·卤肉饭', '今日拼团', 12, '限时特价，预计 30 分钟', ['微辣', '不要辣']], ['拼好饭·韩式拌饭', '今日拼团', 14, '剩余 8 份', ['加泡菜', '不加泡菜']]],
  跑腿: [['帮买咖啡/奶茶', '同城跑腿', 10, '填写商品和取货地址后下单', ['即时取送', '预约送达']], ['帮取快递', '同城跑腿', 12, '取件码仅用于本次服务', ['送到门口', '放驿站']]],
};
const allItems = (round: number) => CATEGORIES.flatMap(({ name }, ci) => SEEDS[name].map((v, i) => ({ id: `${name}-${round}-${i}`, category: name, name: v[0], shop: `${v[1]} · ${round % 2 ? '今日推荐' : '附近热卖'}`, price: v[2] + ((round + ci + i) % 3) * 2, desc: v[3], options: v[4], image: CATEGORIES[ci].icon })));

export default function TakeoutApp() {
  const { closeApp, characters, addToast, showError, activeCharacterId, userProfile, groups, realtimeConfig, apiConfig, updateCharacter } = useOS();
  const [round, setRound] = useState(() => Number(localStorage.getItem('nmj-takeout-round') || 1));
  const [address, setAddress] = useState(() => localStorage.getItem('nmj-takeout-address') || '虚拟地址 · 上海静安区');
  const [mode, setMode] = useState<'virtual' | 'real'>(() => (localStorage.getItem('nmj-takeout-mode') as 'virtual' | 'real') || 'virtual');
  const [category, setCategory] = useState<Category | null>(null);
  const [query, setQuery] = useState(''); const [cart, setCart] = useState<Item[]>([]); const [detail, setDetail] = useState<Item | null>(null);
  const [selected, setSelected] = useState<string>(''); const [checkout, setCheckout] = useState(false); const [generated, setGenerated] = useState<Item[] | null>(null); const [refreshing, setRefreshing] = useState(false); const [useSecondary, setUseSecondary] = useState(() => localStorage.getItem('nmj-takeout-api') === 'secondary'); const fallbackItems = useMemo(() => allItems(round), [round]); const items = generated || fallbackItems;
  useEffect(() => { localStorage.setItem('nmj-takeout-round', String(round)); localStorage.setItem('nmj-takeout-address', address); localStorage.setItem('nmj-takeout-mode', mode); localStorage.setItem('nmj-takeout-api', useSecondary ? 'secondary' : 'main'); }, [round, address, mode, useSecondary]);
  const refreshAll = async () => {
    const secondary = JSON.parse(localStorage.getItem('nmj-takeout-secondary-api') || 'null') as APIConfig | null;
    const cfg = useSecondary ? secondary : apiConfig;
    if (!cfg?.baseUrl || !cfg.apiKey || !cfg.model) { showError('外卖刷新失败', useSecondary ? '请先在外卖 App 配置副 API 的 URL、Key 和模型。' : '请先在设置中完成主 API 配置。'); return; }
    setRefreshing(true); try {
      const prompt = `你是外卖推荐引擎。地址：${address}；搜索：${query || '无'}。返回严格 JSON 数组，覆盖美食、甜点饮品、超市便利、蔬菜水果、看病买药、早餐、拼好饭、跑腿八类，每类至少1项。字段 category,name,shop,price,desc,options；category只能是上述八类，price是数字，options是符合商品的真实规格数组。不要markdown。`;
      const data = await safeFetchJson(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${cfg.apiKey}`}, body:JSON.stringify({model:cfg.model,stream:false,messages:[{role:'user',content:prompt}]}) });
      const raw = data?.choices?.[0]?.message?.content || ''; const parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g,''));
      if (!Array.isArray(parsed)) throw new Error('模型未返回推荐数组');
      setGenerated(parsed.map((x:any,i:number)=>({ id:`ai-${Date.now()}-${i}`, category:CATEGORIES.some(c=>c.name===x.category)?x.category:'美食', name:String(x.name), shop:String(x.shop), price:Number(x.price)||20, desc:String(x.desc||''), options:Array.isArray(x.options)?x.options.map(String):['标准'], image:CATEGORIES.find(c=>c.name===x.category)?.icon||'🍜' })));
      addToast('已通过 API 刷新全部分类推荐','success');
    } catch (e:any) { showError('外卖刷新失败', e?.message || '请检查 API 配置和网络。'); } finally { setRefreshing(false); }
  };
  const shown = items.filter(x => (!category || x.category === category) && (!query || `${x.name}${x.shop}${x.desc}`.includes(query)));
  const add = () => { if (!detail) return; setCart(c => [...c, { ...detail, desc: selected ? `${detail.desc} · ${selected}` : detail.desc }]); setDetail(null); addToast('已加入购物车', 'success'); };
  const pay = async (target: string) => {
    const deliveryMinutes = 25 + Math.floor(Math.random() * 11);
    const fee = 3 + Math.floor(Math.random() * 5);
    const order = { id: Date.now(), target, items: cart, address, createdAt: Date.now(), deliveryMinutes, fee, etaAt: Date.now() + deliveryMinutes * 60000 };
    const prior = JSON.parse(localStorage.getItem('nmj-takeout-orders') || '[]'); localStorage.setItem('nmj-takeout-orders', JSON.stringify([order, ...prior]));
    const targetChar = characters.find(c => target === c.name || target === `${c.name} 代付`);
    const cardTarget = target === '自己' ? '为自己下单' : target.endsWith('代付') ? `${target} · 已代付` : `送给 ${target}`;
    const rows = cart.map(x => `<div style="display:flex;justify-content:space-between;margin-top:6px"><span>${x.name}</span><b>¥${x.price}</b></div>`).join('');
    const html = `<div style="width:270px;padding:18px;border-radius:16px;background:linear-gradient(135deg,#fff7df,#fff);font-family:system-ui;color:#4b3424"><div style="font-size:11px;letter-spacing:2px;opacity:.55">TAKEOUT · ORDER</div><div style="font-size:19px;font-weight:700;margin-top:5px">外卖订单已提交</div><div style="font-size:12px;margin-top:6px;color:#8a6b55">${cardTarget} · 预计 ${deliveryMinutes} 分钟送达</div><div style="margin-top:12px;padding-top:8px;border-top:1px solid #f0dfc4">${rows}</div><div style="display:flex;justify-content:space-between;margin-top:12px;font-size:13px"><span>配送费 ¥${fee}</span><b>合计 ¥${cart.reduce((n,x)=>n+x.price,0)+fee}</b></div><div style="font-size:11px;margin-top:10px;opacity:.58">送至：${address}</div></div>`;
    const recipientId = targetChar?.id || activeCharacterId;
    if (recipientId) await DB.saveMessage({ charId: recipientId, role: 'user', type: 'html_card', content: '[HTML卡片] 外卖订单已提交', metadata: { htmlSource: html, htmlTextPreview: `外卖订单：${cardTarget}，预计${deliveryMinutes}分钟送达，配送费${fee}元`, source: 'takeout', order } });
    if (targetChar?.activeMsg2Config?.enabled) {
      const d = new Date(order.etaAt); const sendAt = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:00`;
      const session = createAmsg2ToolSession({ char: targetChar, userProfile, groups, realtimeConfig, apiConfig, updateCharacter });
      await executeAmsg2Tool('schedule_active_message', { send_at: sendAt, mode: 'prompted', prompt_hint: `外卖预计已送达。自然提醒用户取餐；订单是${cart.map(x=>x.name).join('、')}，${target === `${targetChar.name} 代付` ? '你已代付。' : '请结合是谁收餐自然回应。'}`, recurrence: 'none', expire_policy: 'force' }, session);
    }
    setCart([]); setCheckout(false); addToast(target === '自己' ? `订单已创建，约 ${deliveryMinutes} 分钟送达` : `订单已创建，角色将在送达时知道取餐`, 'success');
  };
  return <div className="h-full overflow-y-auto bg-[#f7f7f7] text-slate-800 pb-24">
    <header className="sticky top-0 z-10 bg-gradient-to-b from-[#ffe93c] to-[#fff4a8] px-4 pt-5 pb-3 shadow-sm"><div className="flex items-center gap-2 text-sm"><button onClick={closeApp}><ArrowLeft size={20}/></button><MapPin weight="fill" className="text-orange-600" size={18}/><input className="min-w-0 flex-1 bg-transparent font-semibold outline-none" value={address} onChange={e=>setAddress(e.target.value)} /><button onClick={()=>setMode(mode==='virtual'?'real':'virtual')} className="rounded-full bg-white/75 px-2 py-1 text-xs">{mode === 'virtual' ? '虚拟地址' : '真实 POI'}</button><button onClick={refreshAll} aria-label="刷新全部推荐" disabled={refreshing}><ArrowsClockwise className={refreshing?'animate-spin':''} size={22}/></button></div><div className="mt-2 text-right"><button onClick={()=>setUseSecondary(v=>!v)} className="rounded-full bg-white/65 px-2 py-1 text-[10px]">{useSecondary?'副 API':'主 API'}</button></div><div className="mt-2 flex rounded-xl bg-white px-3 py-2 shadow-sm"><MagnifyingGlass size={19} className="mr-2 text-slate-400"/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索外卖、商品或店铺" className="min-w-0 flex-1 outline-none text-sm"/><button onClick={refreshAll} className="text-sm font-bold text-orange-600">{refreshing?'请求中':'搜索'}</button></div>{mode==='real' && <p className="mt-2 text-[11px] text-slate-600">真实 POI 模式将在配置高德 Key 后搜索附近店铺；当前为安全演示数据。</p>}</header>
    {!category && <section className="grid grid-cols-4 gap-y-4 bg-white px-3 py-5">{CATEGORIES.map(c=><button key={c.name} onClick={()=>setCategory(c.name)} className="flex flex-col items-center gap-1 text-xs"><span className={`grid h-12 w-12 place-items-center rounded-2xl text-2xl ${c.tint}`}>{c.icon}</span>{c.name}</button>)}</section>}
    <main className="px-3 pt-3"><div className="mb-2 flex items-center justify-between"><h2 className="font-bold">{category ? `${category} · 推荐` : '今日为你推荐'}</h2>{category && <button onClick={()=>setCategory(null)} className="text-xs text-slate-500">全部分类 <CaretRight size={12} className="inline"/></button>}</div>{shown.map(item=><button key={item.id} onClick={()=>{setDetail(item);setSelected(item.options[0])}} className="mb-3 flex w-full gap-3 rounded-2xl bg-white p-3 text-left shadow-sm"><span className="grid h-20 w-20 shrink-0 place-items-center rounded-xl bg-orange-50 text-4xl">{item.image}</span><span className="min-w-0 flex-1"><b className="block truncate">{item.name}</b><small className="block mt-1 text-slate-500">{item.shop}</small><small className="mt-1 line-clamp-1 text-slate-400">{item.desc}</small><strong className="mt-2 block text-orange-600">¥{item.price}</strong></span><Plus className="self-end rounded-full bg-orange-500 p-1 text-white" size={25}/></button>)}</main>
    {cart.length>0 && <button onClick={()=>setCheckout(true)} className="fixed bottom-4 left-5 right-5 z-20 flex items-center justify-between rounded-full bg-slate-900 px-5 py-3 text-white shadow-xl"><span><ShoppingCartSimple size={22} className="inline mr-2"/>购物车 {cart.length} 件</span><b>¥{cart.reduce((n,x)=>n+x.price,0)} 去结算</b></button>}
    {detail && <div className="fixed inset-0 z-30 flex items-end bg-black/35"><div className="w-full rounded-t-3xl bg-white p-5"><button className="float-right" onClick={()=>setDetail(null)}><X/></button><h2 className="text-xl font-bold">{detail.name}</h2><p className="mt-1 text-sm text-slate-500">{detail.shop}</p><h3 className="mt-5 font-bold">口味/规格</h3><div className="mt-2 flex flex-wrap gap-2">{detail.options.map(x=><button key={x} onClick={()=>setSelected(x)} className={`rounded-lg px-3 py-2 text-sm ${selected===x?'bg-orange-500 text-white':'bg-slate-100'}`}>{x}</button>)}</div><button onClick={add} className="mt-6 w-full rounded-xl bg-orange-500 py-3 font-bold text-white">¥{detail.price} 加入购物车</button></div></div>}
    {checkout && <div className="fixed inset-0 z-30 flex items-end bg-black/35"><div className="w-full rounded-t-3xl bg-white p-5"><button className="float-right" onClick={()=>setCheckout(false)}><X/></button><h2 className="text-xl font-bold">确认订单</h2><p className="mt-2 text-sm text-slate-500">送至：{address}</p><p className="mt-4 font-bold">这单外卖给谁买？</p><div className="mt-3 grid gap-2"><button onClick={()=>pay('自己')} className="rounded-xl bg-orange-500 py-3 text-white">给自己买</button>{characters.slice(0,5).map(c=><button key={c.id} onClick={()=>pay(c.name)} className="rounded-xl bg-slate-100 py-3">给 {c.name} 买</button>)}{characters.slice(0,5).map(c=><button key={c.id+'pay'} onClick={()=>pay(`${c.name} 代付`)} className="rounded-xl border border-orange-300 py-3 text-orange-600">让 {c.name} 代付</button>)}</div></div></div>}
  </div>;
}
