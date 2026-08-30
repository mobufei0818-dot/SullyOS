import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, ArrowsClockwise, CaretLeft, CaretRight, FloppyDisk, GearSix, MagnifyingGlass, MapPin, Plus, ShoppingCartSimple, X } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { ActiveMsgClient } from '../utils/activeMsgClient';
import { applyScheduledTask } from '../utils/amsg2Tasks';
import { safeFetchJson } from '../utils/safeApi';
import { nowInTimeZone, resolveCharTimeZone } from '../utils/timezone';
import { buildTakeoutOrderCard, saveTakeoutOrder } from '../utils/takeoutOrder';
import TakeoutAddressSettings from '../components/takeout/TakeoutAddressSettings';
import { loadTakeoutAddressBook, persistTakeoutAddressBook, resolveTakeoutAddress, testAmapPoi } from '../utils/takeoutAddressBook';
import type { TakeoutAddressBook } from '../utils/takeoutAddressBook';
import type { APIConfig, ActiveMsg2TaskRecord, CharacterProfile } from '../types';

type Category = '美食' | '甜点饮品' | '超市便利' | '蔬菜水果' | '看病买药' | '早餐' | '拼好饭' | '跑腿';
type Item = { id: string; name: string; shop: string; price: number; desc: string; category: Category; image: string; options: string[] };
type SecondaryConfig = APIConfig;
const TAKEOUT_KEY = 'nmj-takeout-catalog-v2';
const CATEGORIES: { name: Category; icon: string; tint: string }[] = [
  { name: '美食', icon: '🍜', tint: 'bg-orange-50' }, { name: '甜点饮品', icon: '🧋', tint: 'bg-pink-50' },
  { name: '超市便利', icon: '🛒', tint: 'bg-sky-50' }, { name: '蔬菜水果', icon: '🍓', tint: 'bg-emerald-50' },
  { name: '看病买药', icon: '💊', tint: 'bg-cyan-50' }, { name: '早餐', icon: '🥪', tint: 'bg-amber-50' },
  { name: '拼好饭', icon: '🍱', tint: 'bg-red-50' }, { name: '跑腿', icon: '🛵', tint: 'bg-violet-50' },
];
const RECIPES: Record<Category, Array<[string, string, number, string, string[]]>> = {
  美食: [['招牌黄焖鸡米饭','巷口黄焖鸡',22,'现焖鸡腿肉，米饭免费续',['微辣','中辣','特辣']],['番茄牛肉米线','滇味小馆',25,'酸甜汤底，配大片牛肉',['不要香菜','加酸笋','加辣油']],['川香回锅肉盖饭','灶台小炒',24,'锅气十足的下饭小炒',['不辣','微辣','重辣']],['日式照烧鸡排饭','町食堂',28,'现煎鸡排，照烧酱汁',['加温泉蛋','多酱','不要洋葱']],['酸菜鱼单人餐','江湖小馆',31,'巴沙鱼片与爽脆酸菜',['微辣','中辣','加金针菇']]],
  甜点饮品: [['生椰拿铁','树夏咖啡',19,'椰香浓郁，现萃咖啡',['全糖','七分糖','三分糖','少冰','去冰']],['芝芝葡萄','茶屿',22,'鲜果与轻芝士',['正常冰','少冰','去冰','五分糖','无糖']],['伯爵奶茶','午后茶事',17,'伯爵红茶与鲜奶',['全糖','半糖','无糖','热饮']],['草莓酸奶碗','莓好日子',26,'草莓、燕麦与浓稠酸奶',['加坚果','不加燕麦']],['冰美式','咖啡候车室',15,'坚果香气，清爽回甘',['正常冰','少冰','去冰']]],
  超市便利: [['深夜零食补给包','便利蜂',28,'薯片、气泡水和巧克力',['需要餐具','不要餐具']],['冰鲜纯牛奶','邻里超市',16,'2L 家庭装',['冷藏配送','常温配送']],['无糖气泡水','生活便利店',9,'500ml × 2',['冰镇','常温']],['日用补给组合','叮咚便利',35,'纸巾、洗手液和垃圾袋',['普通袋装','环保袋装']],['经典薯片分享装','夜猫商店',14,'原味大包装',['原味','黄瓜味','番茄味']]],
  蔬菜水果: [['阳光玫瑰葡萄','每日鲜果',32,'精选 500g',['帮我挑甜的','普通挑选']],['时令蔬菜组合','菜场到家',20,'适合两人一餐',['切好','整份']],['云南蓝莓','果园直送',29,'新鲜 125g × 2',['优先大果','普通挑选']],['番茄鸡蛋食材包','邻家菜篮',18,'番茄、鸡蛋与葱花',['切配','不切配']],['冰糖心苹果','鲜果时光',23,'脆甜多汁 1kg',['偏甜','普通挑选']]],
  看病买药: [['感冒药家庭装','安心大药房',26,'请按说明书使用',['需要发票','隐私配送']],['创可贴组合','健康便利店',12,'轻便防水款',['普通包装','隐私配送']],['退热贴','康宁药房',18,'物理降温，请遵医嘱',['儿童款','成人款','隐私配送']],['维生素C泡腾片','元气药房',25,'柠檬口味 20 片',['普通包装','隐私配送']],['口罩独立装','守护药房',15,'医用外科口罩',['10只装','20只装']]],
  早餐: [['豆浆油条套餐','清晨食堂',12,'现磨豆浆 + 油条',['甜豆浆','无糖豆浆','加鸡蛋']],['培根蛋可颂','面包街',18,'热压现做',['加芝士','不要酱']],['鲜肉小笼包','早安蒸点',15,'现蒸 8 只',['加醋包','不要葱']],['鸡蛋三明治','晨光咖啡',16,'吐司现烤',['加火腿','加芝士','不加酱']],['皮蛋瘦肉粥','粥到',14,'暖胃现熬',['加油条','不要葱']]],
  拼好饭: [['拼好饭·卤肉饭','今日拼团',12,'限时特价，预计 30 分钟',['微辣','不要辣']],['拼好饭·韩式拌饭','今日拼团',14,'剩余 8 份',['加泡菜','不加泡菜']],['拼好饭·鸡腿饭','饭点拼团',13,'第二件更优惠',['加卤蛋','不加青菜']],['拼好饭·酸辣粉','午餐拼团',10,'拼单已省 6 元',['微辣','中辣']],['拼好饭·番茄面','好饭研究所',11,'热卖拼单款',['加煎蛋','不要香菜']]],
  跑腿: [['帮买咖啡/奶茶','同城跑腿',10,'填写商品和取货地址后下单',['即时取送','预约送达']],['帮取快递','同城跑腿',12,'取件码仅用于本次服务',['送到门口','放驿站']],['帮送文件','闪送小哥',15,'同城文件急送',['普通件','加急件']],['代排队取号','城市跑腿',18,'医院、餐厅取号服务',['即时','预约']],['帮买日用品','邻里跑腿',11,'备注需要购买的商品',['即时取送','预约送达']]],
};
const makeItems = (category: Category, count: number, start = 0, prefix = 'seed'): Item[] => Array.from({ length: count }, (_, offset) => {
  const index = start + offset; const recipe = RECIPES[category][index % RECIPES[category].length]; const c = CATEGORIES.find(x => x.name === category)!;
  return { id: `${prefix}-${category}-${index}-${Date.now()}`, category, name: index < RECIPES[category].length ? recipe[0] : `${recipe[0]} ${['精选款','人气款','推荐套餐','限定组合'][Math.floor(index / RECIPES[category].length) % 4]}`, shop: `${recipe[1]} · ${index % 2 ? '附近热卖' : '今日推荐'}`, price: recipe[2] + (index % 4) * 2, desc: recipe[3], options: recipe[4], image: c.icon };
});
const homeSeed = () => CATEGORIES.flatMap(({ name }) => makeItems(name, 2, 0, 'home')).slice(0, 10);
const initialCatalogs = () => Object.fromEntries(CATEGORIES.map(c => [c.name, makeItems(c.name, 10)])) as Record<Category, Item[]>;
const savedCatalog = () => { try { return JSON.parse(localStorage.getItem(TAKEOUT_KEY) || '{}') as { home?: Item[]; catalogs?: Record<Category, Item[]>; searchResults?: Item[]; searchQuery?: string }; } catch { return {}; } };
const cleanBaseUrl = (url: string) => url.replace(/\/+$/, '');
const parseArray = (value: string) => { const fenced = value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''); const match = fenced.match(/\[[\s\S]*\]/); return JSON.parse(match?.[0] || fenced); };
const specChoices = (category: Category): Array<[string, number]> => category === '甜点饮品' ? [['中杯', 0], ['大杯', 3], ['超大杯', 6]] : category === '美食' || category === '早餐' || category === '拼好饭' ? [['标准份', 0], ['加量', 4], ['双拼', 8]] : category === '蔬菜水果' ? [['500g', 0], ['1kg', 8], ['家庭装', 15]] : category === '看病买药' ? [['标准装', 0], ['家庭装', 8], ['加量装', 15]] : [['标准规格', 0], ['加大规格', 5], ['组合装', 10]];

export default function TakeoutApp() {
  const { closeApp, characters, addToast, showError, activeCharacterId, userProfile, groups, realtimeConfig, apiConfig, updateCharacter } = useOS();
  const [addressBook, setAddressBook] = useState<TakeoutAddressBook>(loadTakeoutAddressBook);
  const [deliveryRecipient, setDeliveryRecipient] = useState<{ kind: 'user' } | { kind: 'character'; characterId: string }>(() => activeCharacterId ? { kind: 'character', characterId: activeCharacterId } : { kind: 'user' });
  const location = useMemo(() => resolveTakeoutAddress(addressBook, deliveryRecipient), [addressBook, deliveryRecipient]);
  const [home, setHome] = useState<Item[]>(() => savedCatalog().home || homeSeed());
  const [catalogs, setCatalogs] = useState<Record<Category, Item[]>>(() => ({ ...initialCatalogs(), ...(savedCatalog().catalogs || {}) }));
  const [category, setCategory] = useState<Category | null>(null); const [page, setPage] = useState(0);
  const [query, setQuery] = useState(() => savedCatalog().searchQuery || ''); const [searchResults, setSearchResults] = useState<Item[] | null>(() => savedCatalog().searchResults || null);
  const [cart, setCart] = useState<Item[]>([]); const [cartOpen, setCartOpen] = useState(false); const [selectedCartIds, setSelectedCartIds] = useState<string[]>([]); const [detail, setDetail] = useState<Item | null>(null); const [selected, setSelected] = useState(''); const [selectedSpec, setSelectedSpec] = useState<[string, number]>(['标准规格', 0]); const [checkout, setCheckout] = useState(false); const [checkoutTarget, setCheckoutTarget] = useState<string | null>(null); const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false); const [settingsOpen, setSettingsOpen] = useState(false); const [apiOpen, setApiOpen] = useState(false);
  const [useSecondary, setUseSecondary] = useState(() => localStorage.getItem('nmj-takeout-api') === 'secondary');
  const [secondary, setSecondary] = useState<SecondaryConfig>(() => ({ baseUrl: '', apiKey: '', model: '', ...JSON.parse(localStorage.getItem('nmj-takeout-secondary-api') || '{}') }));
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  // PhoneShell 给每个 App 一个固定视口；外卖的列表只能在内容区滚动，不能把整台“手机”推走。
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('.sully-shell-content [class*="bg-[#f7f7f7]"]');
    if (!root) return;
    root.classList.add('takeout-mobile-root');
    const style = document.createElement('style');
    style.textContent = `
      .takeout-mobile-root { display:flex !important; flex-direction:column; min-height:0; overflow:hidden !important; padding-bottom:0 !important; overscroll-behavior:none; }
      .takeout-mobile-root > header, .takeout-mobile-root > section { flex:0 0 auto; }
      .takeout-mobile-root > header { position:relative !important; top:auto !important; }
      .takeout-mobile-root > main { flex:1 1 0%; min-height:0; overflow-y:auto !important; overscroll-behavior:contain; padding-bottom:calc(6rem + env(safe-area-inset-bottom)) !important; }
      .takeout-mobile-root > .fixed { position:absolute !important; }
      .takeout-mobile-root > button.fixed { bottom:calc(1rem + env(safe-area-inset-bottom)) !important; }
      .takeout-mobile-root > .fixed.inset-0 > div { max-height:calc(100% - env(safe-area-inset-top) - 8px); overflow-y:auto; overscroll-behavior:contain; padding-bottom:calc(1.25rem + env(safe-area-inset-bottom)); }
    `;
    document.head.appendChild(style);
    return () => { root.classList.remove('takeout-mobile-root'); style.remove(); };
  }, []);
  useEffect(() => { if (detail) { setSelected(detail.options[0] || '标准'); setSelectedSpec(specChoices(detail.category)[0]); } }, [detail?.id]);
  useEffect(() => {
    if (!detail) return;
    const root = document.querySelector<HTMLElement>('.takeout-mobile-root'); const title = [...(root?.querySelectorAll('h2') || [])].find(node => node.textContent === detail.name);
    const sheet = title?.parentElement; const oldTitle = [...(sheet?.querySelectorAll('h3') || [])].find(node => node.textContent === '口味/规格'); const oldOptions = oldTitle?.nextElementSibling as HTMLElement | null;
    if (!sheet || !oldTitle || !oldOptions) return;
    oldTitle.style.display = 'none'; oldOptions.style.display = 'none';
    const block = document.createElement('div'); block.className = 'mt-5 space-y-3';
    const makeGroup = (label: string, choices: Array<[string, number]>, selectedName: string, choose: (choice: [string, number]) => void) => { const group = document.createElement('div'); const h = document.createElement('h3'); h.className = 'font-bold'; h.textContent = label; const row = document.createElement('div'); row.className = 'mt-2 flex flex-wrap gap-2'; choices.forEach(choice => { const b = document.createElement('button'); b.className = `rounded-lg px-3 py-2 text-sm ${choice[0] === selectedName ? 'bg-orange-500 text-white' : 'bg-slate-100'}`; b.textContent = choice[1] ? `${choice[0]} +¥${choice[1]}` : choice[0]; b.onclick = () => choose(choice); row.appendChild(b); }); group.append(h, row); return group; };
    block.append(makeGroup('口味', detail.options.map(x => [x, 0]), selected, choice => setSelected(choice[0])), makeGroup('规格', specChoices(detail.category), selectedSpec[0], choice => setSelectedSpec(choice)));
    oldOptions.parentElement?.insertBefore(block, oldOptions.nextSibling); const addButton = [...sheet.querySelectorAll('button')].find(button => button.textContent?.includes('加入购物车')); if (addButton) addButton.textContent = `¥${detail.price + selectedSpec[1]} 加入购物车`;
    return () => block.remove();
  }, [detail, selected, selectedSpec]);
  useEffect(() => { persistTakeoutAddressBook(addressBook); localStorage.setItem('nmj-takeout-api', useSecondary ? 'secondary' : 'main'); localStorage.setItem('nmj-takeout-secondary-api', JSON.stringify(secondary)); localStorage.setItem(TAKEOUT_KEY, JSON.stringify({ home, catalogs, searchResults, searchQuery: query })); }, [addressBook, useSecondary, secondary, home, catalogs, searchResults, query]);
  const visible = useMemo(() => searchResults ?? (category ? catalogs[category] : home), [searchResults, category, catalogs, home]);
  const totalPages = Math.max(1, Math.ceil(visible.length / 5)); const displayItems = visible.slice(page * 5, page * 5 + 5);
  useEffect(() => setPage(0), [category, searchResults]);
  const currentConfig = () => useSecondary ? secondary : apiConfig;
  const openAddressSettings = () => {
    const host = document.createElement('div');
    host.className = 'takeout-address-settings-host';
    document.body.appendChild(host);
    const root = createRoot(host);
    const close = () => { root.unmount(); host.remove(); };
    root.render(<TakeoutAddressSettings book={addressBook} recipient={deliveryRecipient} characters={characters} onRecipientChange={setDeliveryRecipient} onChange={setAddressBook} onClose={close} addToast={addToast}/>);
  };
  useEffect(() => {
    const button = document.querySelector<HTMLButtonElement>('.takeout-mobile-root header > div:first-child button:nth-of-type(2)');
    if (!button) return;
    const intercept = (event: MouseEvent) => { event.preventDefault(); event.stopImmediatePropagation(); openAddressSettings(); };
    button.addEventListener('click', intercept, true);
    return () => button.removeEventListener('click', intercept, true);
  }, [addressBook, deliveryRecipient, characters, addToast]);
  useEffect(() => {
    const label = deliveryRecipient.kind === 'user' ? (userProfile.name || '用户') : (characters.find(char => char.id === deliveryRecipient.characterId)?.name || '角色');
    const addressLabel = document.querySelector<HTMLElement>('.takeout-mobile-root header > div:first-child button:nth-of-type(2) span');
    if (addressLabel) addressLabel.textContent = `${label} · ${location.address || '输入收货地址'}`;
  }, [deliveryRecipient, location.address, characters, userProfile.name]);
  const scheduleTakeoutArrival = async (char: CharacterProfile, order: { etaAt: number; items: Item[]; target: string }) => {
    const config = char.activeMsg2Config;
    if (!config?.enabled) throw new Error(`「${char.name}」的主动消息 2.0 未开启，无法创建送达提醒。`);
    const wallClock = nowInTimeZone(resolveCharTimeZone(char), new Date(order.etaAt));
    const sendAt = `${wallClock.getFullYear()}-${String(wallClock.getMonth()+1).padStart(2,'0')}-${String(wallClock.getDate()).padStart(2,'0')}T${String(wallClock.getHours()).padStart(2,'0')}:${String(wallClock.getMinutes()).padStart(2,'0')}:00`;
    const promptHint = `现在才是外卖预计送达时刻。订单商品：${order.items.map(x => x.name).join('、')}；${order.target === `${char.name} 代付` ? '你已代付。' : '这是送给你的外卖。'}自然提醒用户取餐；此前绝不能声称已经收到、送达或吃完。`;
    const result = await ActiveMsgClient.scheduleCharacterTask({ char, config, task: { mode: 'prompted', firstSendTime: sendAt, recurrenceType: 'none', promptHint, expirePolicy: 'force', selfScheduled: false }, userProfile, groups, realtimeConfig, apiConfig });
    const task: ActiveMsg2TaskRecord = { taskUuid: result.uuid, clientTaskId: result.clientTaskId, mode: 'prompted', firstSendTime: result.firstSendAt, recurrenceType: 'none', promptHint, expirePolicy: 'force', anchorLastUserMsgAt: result.anchorMs, source: 'user', status: 'scheduled', createdAt: Date.now() };
    updateCharacter(char.id, { activeMsg2Config: { ...config, tasks: applyScheduledTask(config.tasks || [], task, {}, Date.now()), lastSyncedAt: Date.now(), lastError: undefined } });
  };
  const poiContext = async () => {
    if (!addressBook.amapKey) return '';
    const result = await testAmapPoi(addressBook.amapKey, location, category || query || '餐饮');
    setAddressBook(book => ({ ...book, lastPoiTest: { ...result, at: Date.now() } }));
    return result.success ? (result.poiNames || []).join('；') : '';
  };
  const requestItems = async (purpose: 'home' | 'category' | 'search') => {
    const cfg = currentConfig();
    if (!cfg?.baseUrl || !cfg.apiKey || !cfg.model) { showError('外卖刷新失败', useSecondary ? '请先在外卖 App 的 API 设置中填写副 API 的 URL、Key 与模型。' : '请先在系统设置中完成主 API 配置。'); return; }
    setRefreshing(true);
    try {
      const poi = await poiContext(); const target = purpose === 'home' ? '八类混合推荐，返回正好10项' : purpose === 'search' ? `搜索“${query}”，返回正好10项且都必须与搜索词直接相关` : `分类“${category}”，返回正好10项且全部属于该分类`;
      const poiRegion = location.mode === 'real' ? location.address : location.mappedAddress;
      const prompt = `你是外卖推荐引擎。收货地址：${location.address}；用于附近商户匹配的地址：${poiRegion}。${poi ? `高德附近 POI：${poi}。` : ''}${target}。严格只输出 JSON 数组，不要 markdown。每项字段：category（只能为${CATEGORIES.map(c=>c.name).join('、')}之一）、name、shop、price（数字）、desc、options（符合该商品的真实规格字符串数组）。商品彼此必须不同，饮品给糖度/冰量，餐食给辣度/加料等。`;
      const data = await safeFetchJson(`${cleanBaseUrl(cfg.baseUrl)}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` }, body: JSON.stringify({ model: cfg.model, stream: false, messages: [{ role: 'user', content: prompt }] }) }, 2, 45000, { appId: 'takeout', appName: '外卖', purpose: purpose === 'search' ? '外卖搜索' : '外卖推荐刷新' });
      const raw = data?.choices?.[0]?.message?.content || ''; const parsed = parseArray(raw); if (!Array.isArray(parsed) || parsed.length < 10) throw new Error('API 没有返回 10 个有效推荐，请检查模型输出。');
      const fresh = parsed.slice(0, 10).map((x: any, i: number): Item => { const valid = CATEGORIES.find(c => c.name === x.category)?.name || category || '美食'; return { id: `api-${Date.now()}-${i}`, category: valid, name: String(x.name || '推荐商品'), shop: String(x.shop || '附近店铺'), price: Math.max(1, Number(x.price) || 20), desc: String(x.desc || ''), options: Array.isArray(x.options) && x.options.length ? x.options.map(String) : ['标准'], image: CATEGORIES.find(c => c.name === valid)!.icon }; });
      // 先落盘再更新 React：用户此时退出 App，进行中的请求仍可把结果留在下次打开的页面里。
      const cached = savedCatalog();
      if (purpose === 'home') { localStorage.setItem(TAKEOUT_KEY, JSON.stringify({ ...cached, home: fresh })); setHome(fresh); }
      else if (purpose === 'search') { localStorage.setItem(TAKEOUT_KEY, JSON.stringify({ ...cached, searchResults: fresh, searchQuery: query })); setSearchResults(fresh); }
      else if (category) { const nextCategory = [...(cached.catalogs?.[category] || catalogs[category]), ...fresh].slice(-30); localStorage.setItem(TAKEOUT_KEY, JSON.stringify({ ...cached, catalogs: { ...(cached.catalogs || catalogs), [category]: nextCategory } })); setCatalogs(old => ({ ...old, [category]: nextCategory })); }
      addToast(purpose === 'home' ? '主页 10 个推荐已由 API 更新' : '已由 API 获取 10 个新推荐', 'success');
    } catch (e: any) { showError('外卖刷新失败', e?.message || '请检查 API 配置、模型输出和网络。'); } finally { setRefreshing(false); }
  };
  const runSearch = () => { if (!query.trim()) { setSearchResults(null); return; } requestItems('search'); };
  const loadModels = async () => { if (!secondary.baseUrl || !secondary.apiKey) { showError('无法拉取模型', '请先填写副 API 的 URL 和 Key。'); return; } try { const data = await safeFetchJson(`${cleanBaseUrl(secondary.baseUrl)}/models`, { headers: { Authorization: `Bearer ${secondary.apiKey}` } }, 1, 30000, { appId: 'takeout', appName: '外卖', purpose: '拉取副 API 模型' }); const models = Array.isArray(data?.data) ? data.data.map((m: any) => m.id).filter(Boolean) : []; setModelOptions(models); if (models[0] && !secondary.model) setSecondary(s => ({ ...s, model: models[0] })); addToast(`已拉取 ${models.length} 个模型`, 'success'); } catch (e: any) { showError('无法拉取模型', e?.message || '请检查副 API URL、Key 和跨域设置。'); } };
  const add = () => { if (!detail) return; const item = { ...detail, id: `${detail.id}-cart-${Date.now()}`, price: detail.price + selectedSpec[1], desc: `${detail.desc}${selected ? ` · 口味：${selected}` : ''} · 规格：${selectedSpec[0]}` }; setCart(c => [...c, item]); setSelectedCartIds(ids => [...ids, item.id]); setDetail(null); addToast('已加入购物车', 'success'); };
  const confirmPay = async () => { if (!checkoutTarget || submitting || !cart.length) return; setSubmitting(true); try { await pay(checkoutTarget); } catch (error: any) { showError('订单后续处理失败', error?.message || '订单已创建，但提醒写入失败。'); } finally { setSubmitting(false); setCheckoutTarget(null); setCheckout(false); } };
  // 先截住“给谁买”按钮，再显示二次确认；避免一碰按钮就直接下单，也保留购物车的合并结算。
  useEffect(() => {
    if (!checkout) { setCheckoutTarget(null); return; }
    const intercept = (event: MouseEvent) => {
      const button = (event.target as HTMLElement).closest('button');
      const text = button?.textContent?.trim() || '';
      if (!button || !/^(给自己买|给 .+ 买|让 .+ 代付)$/.test(text)) return;
      event.preventDefault(); event.stopImmediatePropagation(); event.stopPropagation();
      setCheckoutTarget(text === '给自己买' ? '自己' : text.startsWith('让 ') ? `${text.slice(2, -2)} 代付` : text.slice(2, -2));
    };
    document.addEventListener('click', intercept, true);
    return () => document.removeEventListener('click', intercept, true);
  }, [checkout]);
  useEffect(() => {
    const interceptCart = (event: MouseEvent) => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button || !button.textContent?.includes('购物车') || !button.textContent.includes('去结算')) return;
      event.preventDefault(); event.stopImmediatePropagation(); event.stopPropagation(); setCartOpen(true);
    };
    document.addEventListener('click', interceptCart, true);
    return () => document.removeEventListener('click', interceptCart, true);
  }, []);
  useEffect(() => {
    if (!cartOpen) return;
    const root = document.querySelector<HTMLElement>('.takeout-mobile-root');
    if (!root) return;
    const mask = document.createElement('div'); mask.className = 'absolute inset-0 z-[55] flex items-end bg-black/45';
    const panel = document.createElement('div'); panel.className = 'w-full max-h-[80%] overflow-y-auto rounded-t-3xl bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]';
    const heading = document.createElement('div'); heading.className = 'flex items-center justify-between'; const title = document.createElement('h2'); title.className = 'text-xl font-bold'; title.textContent = '购物车'; const close = document.createElement('button'); close.className = 'text-slate-500'; close.textContent = '关闭'; close.onclick = () => setCartOpen(false); heading.append(title, close); panel.appendChild(heading);
    const all = document.createElement('button'); all.className = 'mt-3 text-sm text-orange-600'; all.textContent = selectedCartIds.length === cart.length ? '取消全选' : '全选'; all.onclick = () => setSelectedCartIds(selectedCartIds.length === cart.length ? [] : cart.map(item => item.id)); panel.appendChild(all);
    cart.forEach(item => { const row = document.createElement('div'); row.className = 'mt-3 flex items-center gap-3 rounded-2xl bg-slate-50 p-3'; const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selectedCartIds.includes(item.id); check.className = 'h-5 w-5 accent-orange-500'; check.onchange = () => setSelectedCartIds(ids => check.checked ? [...new Set([...ids, item.id])] : ids.filter(id => id !== item.id)); const info = document.createElement('div'); info.className = 'min-w-0 flex-1'; const name = document.createElement('b'); name.className = 'block truncate text-sm'; name.textContent = item.name; const spec = document.createElement('small'); spec.className = 'block truncate text-slate-500'; spec.textContent = item.desc; info.append(name, spec); const price = document.createElement('b'); price.className = 'text-orange-600'; price.textContent = `¥${item.price}`; const remove = document.createElement('button'); remove.className = 'ml-1 text-sm text-slate-400'; remove.textContent = '删除'; remove.onclick = () => { setCart(items => items.filter(x => x.id !== item.id)); setSelectedCartIds(ids => ids.filter(id => id !== item.id)); }; row.append(check, info, price, remove); panel.appendChild(row); });
    const selectedItems = cart.filter(item => selectedCartIds.includes(item.id)); const payButton = document.createElement('button'); payButton.className = 'mt-5 w-full rounded-xl bg-orange-500 py-3 font-bold text-white disabled:opacity-45'; payButton.disabled = !selectedItems.length; payButton.textContent = selectedItems.length ? `选中 ${selectedItems.length} 件，去结算 ¥${selectedItems.reduce((sum, item) => sum + item.price, 0)}` : '请选择商品'; payButton.onclick = () => { if (!selectedItems.length) return; setCart(selectedItems); setSelectedCartIds(selectedItems.map(item => item.id)); setCartOpen(false); setCheckout(true); }; panel.appendChild(payButton); mask.appendChild(panel); root.appendChild(mask);
    return () => mask.remove();
  }, [cartOpen, cart, selectedCartIds]);
  useEffect(() => {
    if (!checkoutTarget) return;
    const root = document.querySelector<HTMLElement>('.takeout-mobile-root');
    if (!root) return;
    const mask = document.createElement('div');
    mask.className = 'absolute inset-0 z-[60] flex items-end bg-black/45';
    const panel = document.createElement('div');
    panel.className = 'w-full max-h-[78%] overflow-y-auto rounded-t-3xl bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]';
    const title = document.createElement('h2'); title.className = 'text-xl font-bold'; title.textContent = '确认下单';
    const target = document.createElement('p'); target.className = 'mt-2 text-sm text-slate-500'; target.textContent = checkoutTarget === '自己' ? '这单将给自己购买' : checkoutTarget.endsWith(' 代付') ? `将由 ${checkoutTarget.slice(0, -3)} 代付` : `这单将送给 ${checkoutTarget}`;
    const summary = document.createElement('div'); summary.className = 'mt-4 rounded-2xl bg-slate-50 p-3 text-sm text-slate-700';
    const itemTitle = document.createElement('b'); itemTitle.textContent = `购物车共 ${cart.length} 件商品`; summary.appendChild(itemTitle);
    cart.forEach(item => { const row = document.createElement('div'); row.className = 'mt-2 flex justify-between gap-3'; const name = document.createElement('span'); name.className = 'min-w-0 truncate'; name.textContent = item.name; const price = document.createElement('b'); price.textContent = `¥${item.price}`; row.append(name, price); summary.appendChild(row); });
    const total = document.createElement('p'); total.className = 'mt-3 text-right font-bold text-orange-600'; total.textContent = `商品小计 ¥${cart.reduce((sum, item) => sum + item.price, 0)}（配送费将在下单时计算）`;
    const actions = document.createElement('div'); actions.className = 'mt-5 grid grid-cols-2 gap-3';
    const cancel = document.createElement('button'); cancel.className = 'rounded-xl bg-slate-100 py-3 font-bold text-slate-700'; cancel.textContent = '取消'; cancel.onclick = () => setCheckoutTarget(null);
    const confirm = document.createElement('button'); confirm.className = 'rounded-xl bg-orange-500 py-3 font-bold text-white disabled:opacity-60'; confirm.textContent = submitting ? '正在下单…' : '确认下单'; confirm.disabled = submitting; confirm.onclick = () => { void confirmPay(); };
    actions.append(cancel, confirm); panel.append(title, target, summary, total, actions); mask.appendChild(panel); root.appendChild(mask);
    return () => mask.remove();
  }, [checkoutTarget, cart, submitting]);
  const pay = async (target: string) => {
    const deliveryMinutes = 25 + Math.floor(Math.random() * 11);
    const fee = 3 + Math.floor(Math.random() * 5);
    const targetChar = characters.find(c => target === c.name || target === `${c.name} 代付`);
    const recipient = target === '自己' || target.endsWith('代付') ? { kind: 'user' as const } : targetChar ? { kind: 'character' as const, characterId: targetChar.id } : deliveryRecipient;
    const destination = resolveTakeoutAddress(addressBook, recipient);
    const order = { id: Date.now(), target, items: cart, address: destination.address, deliveryDetail: destination.detail, deliveryNote: destination.note, createdAt: Date.now(), deliveryMinutes, fee, etaAt: Date.now() + deliveryMinutes * 60000, placedBy: 'user' as const };
    saveTakeoutOrder(order);
    const { html, textPreview } = buildTakeoutOrderCard(order);
    const recipientId = targetChar?.id || activeCharacterId;
    if (recipientId) await DB.saveMessage({ charId: recipientId, role: 'user', type: 'html_card', content: '[HTML卡片] 外卖订单已提交', metadata: { htmlSource: html, htmlTextPreview: textPreview, source: 'takeout', order } });
    if (targetChar) await scheduleTakeoutArrival(targetChar, order);
    setCart([]); setSelectedCartIds([]); setCheckout(false);
    addToast(target === '自己' ? `订单已创建，约 ${deliveryMinutes} 分钟送达` : `订单已创建，角色会在预计送达时提醒取餐`, 'success');
  };
  const label = searchResults ? `“${query}”的搜索结果` : category ? `${category} · 推荐` : '今日为你推荐';
  return <div className="h-full overflow-y-auto bg-[#f7f7f7] text-slate-800 pb-24"><header className="sticky top-0 z-10 bg-gradient-to-b from-[#ffe93c] to-[#fff4a8] px-4 pt-5 pb-3 shadow-sm"><div className="flex items-center gap-2 text-sm"><button onClick={closeApp}><ArrowLeft size={20}/></button><button onClick={()=>setSettingsOpen(true)} className="flex min-w-0 flex-1 items-center gap-2 text-left"><MapPin weight="fill" className="shrink-0 text-orange-600" size={18}/><span className="truncate font-semibold">{location.address || '输入收货地址'}</span></button><button onClick={()=>requestItems(category ? 'category' : 'home')} aria-label="刷新推荐" disabled={refreshing}><ArrowsClockwise className={refreshing ? 'animate-spin' : ''} size={22}/></button><button onClick={()=>setApiOpen(true)} aria-label="外卖 API 设置"><GearSix size={20}/></button></div><div className="mt-3 flex rounded-xl bg-white px-3 py-2 shadow-sm"><MagnifyingGlass size={19} className="mr-2 text-slate-400"/><input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==='Enter'&&runSearch()} placeholder="搜索外卖、商品或店铺" className="min-w-0 flex-1 outline-none text-sm"/><button onClick={runSearch} className="text-sm font-bold text-orange-600">{refreshing?'请求中':'搜索'}</button></div></header>{!category && !searchResults && <section className="grid grid-cols-4 gap-y-4 bg-white px-3 py-5">{CATEGORIES.map(c=><button key={c.name} onClick={()=>setCategory(c.name)} className="flex flex-col items-center gap-1 text-xs"><span className={`grid h-12 w-12 place-items-center rounded-2xl text-2xl ${c.tint}`}>{c.icon}</span>{c.name}</button>)}</section>}<main className="px-3 pt-3"><div className="mb-2 flex items-center justify-between"><h2 className="font-bold">{label}</h2>{(category || searchResults) && <button onClick={()=>{setCategory(null);setSearchResults(null);setQuery('')}} className="text-xs text-slate-500">全部分类 <CaretRight size={12} className="inline"/></button>}</div>{displayItems.map(item=><button key={item.id} onClick={()=>{setDetail(item);setSelected(item.options[0])}} className="mb-3 flex w-full gap-3 rounded-2xl bg-white p-3 text-left shadow-sm"><span className="grid h-20 w-20 shrink-0 place-items-center rounded-xl bg-orange-50 text-4xl">{item.image}</span><span className="min-w-0 flex-1"><b className="block truncate">{item.name}</b><small className="block mt-1 text-slate-500">{item.shop}</small><small className="mt-1 line-clamp-1 text-slate-400">{item.desc}</small><strong className="mt-2 block text-orange-600">¥{item.price}</strong></span><Plus className="self-end rounded-full bg-orange-500 p-1 text-white" size={25}/></button>)}<div className="flex items-center justify-center gap-3 pb-3 text-sm"><button disabled={page===0} onClick={()=>setPage(p=>p-1)} className="rounded-lg bg-white p-2 disabled:opacity-35"><CaretLeft/></button><span>{page+1} / {totalPages} 页 · {visible.length} 件</span><button disabled={page>=totalPages-1} onClick={()=>setPage(p=>p+1)} className="rounded-lg bg-white p-2 disabled:opacity-35"><CaretRight/></button></div></main>{cart.length>0 && <button onClick={()=>setCheckout(true)} className="fixed bottom-4 left-5 right-5 z-20 flex items-center justify-between rounded-full bg-slate-900 px-5 py-3 text-white shadow-xl"><span><ShoppingCartSimple size={22} className="inline mr-2"/>购物车 {cart.length} 件</span><b>¥{cart.reduce((n,x)=>n+x.price,0)} 去结算</b></button>}{detail && <div className="fixed inset-0 z-30 flex items-end bg-black/35"><div className="w-full rounded-t-3xl bg-white p-5"><button className="float-right" onClick={()=>setDetail(null)}><X/></button><h2 className="text-xl font-bold">{detail.name}</h2><p className="mt-1 text-sm text-slate-500">{detail.shop}</p><h3 className="mt-5 font-bold">口味/规格</h3><div className="mt-2 flex flex-wrap gap-2">{detail.options.map(x=><button key={x} onClick={()=>setSelected(x)} className={`rounded-lg px-3 py-2 text-sm ${selected===x?'bg-orange-500 text-white':'bg-slate-100'}`}>{x}</button>)}</div><button onClick={add} className="mt-6 w-full rounded-xl bg-orange-500 py-3 font-bold text-white">¥{detail.price} 加入购物车</button></div></div>}{checkout && <div className="fixed inset-0 z-30 flex items-end bg-black/35"><div className="w-full rounded-t-3xl bg-white p-5"><button className="float-right" onClick={()=>setCheckout(false)}><X/></button><h2 className="text-xl font-bold">确认订单</h2><p className="mt-2 text-sm text-slate-500">送至：{location.address}</p><p className="mt-4 font-bold">这单外卖给谁买？</p><div className="mt-3 grid gap-2"><button onClick={()=>pay('自己')} className="rounded-xl bg-orange-500 py-3 text-white">给自己买</button>{characters.slice(0,5).map(c=><button key={c.id} onClick={()=>pay(c.name)} className="rounded-xl bg-slate-100 py-3">给 {c.name} 买</button>)}{characters.slice(0,5).map(c=><button key={c.id+'pay'} onClick={()=>pay(`${c.name} 代付`)} className="rounded-xl border border-orange-300 py-3 text-orange-600">让 {c.name} 代付</button>)}</div></div></div>}{settingsOpen && <div className="fixed inset-0 z-40 flex items-end bg-black/35"><div className="w-full space-y-3 rounded-t-3xl bg-white p-5"><button className="float-right" onClick={()=>setSettingsOpen(false)}><X/></button><h2 className="text-xl font-bold">收货地址与附近店铺</h2><label className="block text-sm">收货地址<input value={location.address} onChange={e=>setLocation(v=>({...v,address:e.target.value}))} placeholder="例如：上海静安区" className="mt-1 w-full rounded-xl bg-slate-100 px-3 py-2 outline-none"/></label><div className="flex gap-2 text-sm"><button onClick={()=>setLocation(v=>({...v,mode:'real'}))} className={`rounded-lg px-3 py-2 ${location.mode==='real'?'bg-orange-500 text-white':'bg-slate-100'}`}>真实地址</button><button onClick={()=>setLocation(v=>({...v,mode:'virtual'}))} className={`rounded-lg px-3 py-2 ${location.mode==='virtual'?'bg-orange-500 text-white':'bg-slate-100'}`}>虚拟地址</button></div>{location.mode==='virtual' && <label className="block text-sm">映射真实地点（高德用这个地点找附近店铺）<input value={location.mappedAddress} onChange={e=>setLocation(v=>({...v,mappedAddress:e.target.value}))} placeholder="例如：上海市静安区" className="mt-1 w-full rounded-xl bg-slate-100 px-3 py-2 outline-none"/></label>}<label className="block text-sm">高德 Web 服务 Key<input value={location.amapKey} onChange={e=>setLocation(v=>({...v,amapKey:e.target.value}))} placeholder="仅保存在本机浏览器" className="mt-1 w-full rounded-xl bg-slate-100 px-3 py-2 outline-none"/></label><p className="text-xs text-slate-500">填写 Key 后，API 刷新会把高德 POI 附近店铺作为推荐上下文；GitHub Pages 前端无法隐藏 Key，请只使用设有域名白名单/额度限制的 Key。</p><button onClick={()=>{setSettingsOpen(false);addToast('定位设置已保存','success')}} className="w-full rounded-xl bg-orange-500 py-3 font-bold text-white"><FloppyDisk className="mr-1 inline"/>保存定位设置</button></div></div>}{apiOpen && <div className="fixed inset-0 z-40 flex items-end bg-black/35"><div className="w-full space-y-3 rounded-t-3xl bg-white p-5"><button className="float-right" onClick={()=>setApiOpen(false)}><X/></button><h2 className="text-xl font-bold">外卖 API 设置</h2><div className="flex gap-2 text-sm"><button onClick={()=>setUseSecondary(false)} className={`rounded-lg px-3 py-2 ${!useSecondary?'bg-orange-500 text-white':'bg-slate-100'}`}>沿用主 API</button><button onClick={()=>setUseSecondary(true)} className={`rounded-lg px-3 py-2 ${useSecondary?'bg-orange-500 text-white':'bg-slate-100'}`}>使用副 API</button></div>{useSecondary ? <><label className="block text-sm">副 API URL<input value={secondary.baseUrl} onChange={e=>setSecondary(s=>({...s,baseUrl:e.target.value}))} placeholder="https://.../v1" className="mt-1 w-full rounded-xl bg-slate-100 px-3 py-2 outline-none"/></label><label className="block text-sm">副 API Key<input type="password" value={secondary.apiKey} onChange={e=>setSecondary(s=>({...s,apiKey:e.target.value}))} className="mt-1 w-full rounded-xl bg-slate-100 px-3 py-2 outline-none"/></label><div className="flex gap-2"><label className="min-w-0 flex-1 text-sm">模型{modelOptions.length ? <select value={secondary.model} onChange={e=>setSecondary(s=>({...s,model:e.target.value}))} className="mt-1 w-full rounded-xl bg-slate-100 px-3 py-2"><option value="">选择模型</option>{modelOptions.map(m=><option key={m}>{m}</option>)}</select> : <input value={secondary.model} onChange={e=>setSecondary(s=>({...s,model:e.target.value}))} placeholder="模型名称" className="mt-1 w-full rounded-xl bg-slate-100 px-3 py-2 outline-none"/>}</label><button onClick={loadModels} className="mt-6 rounded-xl bg-slate-100 px-3 text-sm">拉取模型</button></div></> : <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">将使用系统“API 配置”里的 URL、Key 与模型，外卖的刷新/搜索会进入原版 API 调用记录；未配置时会明确提示刷新失败。</p>}<button onClick={()=>{setApiOpen(false);addToast('外卖 API 设置已保存','success')}} className="w-full rounded-xl bg-orange-500 py-3 font-bold text-white">保存 API 设置</button></div></div>}</div>;
}
