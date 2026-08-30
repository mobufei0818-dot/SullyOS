/**
 * 外卖订单的共享数据层。
 *
 * App 内下单和角色聊天下单都通过这里产出同一种订单数据和同一张卡片；模型只需要给出
 * 商品与规格，不能再直接生成一张样式不受控的 HTML 订单卡。
 */
import { loadTakeoutAddressBook, resolveTakeoutAddress, saveConfirmedUserTakeoutAddress } from './takeoutAddressBook';


export type TakeoutOrderItem = {
  id: string;
  name: string;
  price: number;
  desc?: string;
};

export type TakeoutOrder = {
  id: number;
  target: string;
  items: TakeoutOrderItem[];
  address: string;
  deliveryDetail?: string;
  deliveryNote?: string;
  createdAt: number;
  deliveryMinutes: number;
  fee: number;
  etaAt: number;
  placedBy?: 'user' | 'character';
  /** 角色给用户点单时的实际下单人，用于小票展示。 */
  orderedBy?: string;
  fulfillment?: 'simulated' | 'meituan_pending';
};

const ORDER_STORAGE_KEY = 'nmj-takeout-orders';
const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char] || char));

export function saveTakeoutOrder(order: TakeoutOrder): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const prior = JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY) || '[]');
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify([order, ...(Array.isArray(prior) ? prior : [])]));
  } catch {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify([order]));
  }
}

export function takeoutCardTarget(target: string): string {
  if (target === '自己') return '为自己下单';
  if (target === '用户') return '送给你';
  if (target.endsWith('代付')) return `${target} · 已代付`;
  return `送给 ${target}`;
}

export function buildTakeoutOrderCard(order: TakeoutOrder): { html: string; textPreview: string } {
  const isMeituanPending = order.fulfillment === 'meituan_pending';
  const arrivalText = new Date(order.etaAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const cardTarget = takeoutCardTarget(order.target);
  const rows = order.items.map(item => `<div style="display:flex;justify-content:space-between;gap:12px;margin-top:10px;font-size:13px;line-height:1.45"><span style="flex:1">${escapeHtml(item.name)}</span><b style="white-space:nowrap;font-weight:600">¥${item.price}</b></div>`).join('');
  const subtotal = order.items.reduce((sum, item) => sum + item.price, 0);
  const hasEstimatedPrices = subtotal > 0;
  const total = subtotal + order.fee;
  // `meituan_pending` 只是程序侧的履约标记：它决定是否展示外跳入口、是否安排提醒。
  // 角色和角色扮演卡片不应被告知这一层，避免打断“我已经替你点好”的自然互动。
  const status = '已下单';
  const orderedBy = order.orderedBy?.trim() || '角色';
  const note = isMeituanPending ? `送至：${escapeHtml(order.address)}<br/>我给你挑好了，记得留意外卖消息` : `送至：${escapeHtml(order.address)}<br/>预计约 ${order.deliveryMinutes} 分钟送达，请留意取餐提醒`;
  const deliveryRow = isMeituanPending ? `<div style="margin-top:7px;font-size:12px;color:#64594f">实际价格、优惠和配送费以美团页面为准</div>` : `<div style="margin-top:7px;display:flex;justify-content:space-between;font-size:12px;color:#64594f"><span>配送费</span><span>¥${order.fee}</span></div>`;
  const totalRow = isMeituanPending ? (hasEstimatedPrices ? `<div style="margin-top:12px;font-size:12px;color:#76695f">预估商品小计 ¥${subtotal}</div>` : `<div style="margin-top:12px;font-size:12px;color:#76695f">餐品和金额以角色挑选为准</div>`) : `<div style="margin-top:12px;display:flex;align-items:baseline;justify-content:space-between"><span style="font-size:12px;color:#76695f">实付</span><span style="font-size:21px;font-weight:800;color:#e76522">¥${total}</span></div>`;
  const itemRows = isMeituanPending && !hasEstimatedPrices ? order.items.map(item => `<div style="margin-top:10px;font-size:13px;line-height:1.45">${escapeHtml(item.name)}</div>`).join('') : rows;
  const html = `<div style="width:278px;box-sizing:border-box;overflow:hidden;border-radius:5px;background:#fffdfa;color:#242424;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;box-shadow:0 8px 22px rgba(56,40,22,.12)"><div style="height:7px;background:repeating-linear-gradient(135deg,#f5e7d3 0 5px,#fffdfa 5px 10px)"></div><div style="padding:16px 17px 14px"><div style="display:flex;align-items:center;justify-content:space-between"><div style="font-size:10px;letter-spacing:1.8px;color:#a17c5b">外卖 · ${escapeHtml(orderedBy)}为你下单</div><div style="border:1px solid #e8c9a4;border-radius:999px;padding:3px 7px;font-size:10px;color:#c66b2b">${status}</div></div><div style="margin-top:9px;font-size:19px;font-weight:750;letter-spacing:.2px">外卖订单</div><div style="margin-top:4px;font-size:11px;color:#84786d">${escapeHtml(cardTarget)}${isMeituanPending ? ` · ${escapeHtml(orderedBy)}已为你挑好` : ` · 预计 ${arrivalText} 送达`}</div><div style="margin-top:12px;border-top:1px dashed #dbcdbd"></div><div style="padding:2px 0 4px">${itemRows}</div><div style="border-top:1px dashed #dbcdbd"></div>${hasEstimatedPrices || !isMeituanPending ? `<div style="margin-top:10px;display:flex;justify-content:space-between;font-size:12px;color:#64594f"><span>商品小计</span><span>¥${subtotal}</span></div>` : ''}${deliveryRow}${totalRow}<div style="margin-top:12px;padding-top:10px;border-top:1px dashed #dbcdbd;font-size:11px;line-height:1.55;color:#8c8177">${note}</div></div><div style="height:7px;background:repeating-linear-gradient(45deg,#f5e7d3 0 5px,#fffdfa 5px 10px)"></div></div>`;
  return { html, textPreview: isMeituanPending ? `${orderedBy}已经为你点了外卖：${order.items.map(item => item.name).join('、')}；送至${order.address}。` : `外卖订单：${cardTarget}；商品：${order.items.map(item => item.name).join('、')}；预计 ${arrivalText} 送达（${order.deliveryMinutes}分钟后），当前尚未送达。配送费${order.fee}元。` };
}

/**
 * 角色确认下单后输出的紧凑指令：
 * [[TAKEOUT_ORDER: 商品名|价格|规格; 商品名|价格|规格]]
 * 仅由程序生成订单，模型输出的文字不会直接成为卡片样式。
 */
export function extractRoleTakeoutOrders(content: string, orderedBy?: string, conversation: Array<{ role?: string; content?: string }> = []): { cleanedContent: string; orders: TakeoutOrder[] } {
  let cleaned = content.replace(/\[\[TAKEOUT_ADDRESS:\s*([^\]]+?)\s*\]\]/gi, (_all, raw: string) => {
    const [nameRaw, addressRaw, modeRaw, mappedRaw] = raw.split('|').map(value => value.trim());
    // This directive is only emitted after the user has explicitly confirmed a travel/current address in conversation.
    if (!nameRaw) return '';
    saveConfirmedUserTakeoutAddress({ name: nameRaw.slice(0, 30), address: (addressRaw || '').slice(0, 120), mode: modeRaw, mappedAddress: (mappedRaw || '').slice(0, 120) });
    return '';
  });
  const location = resolveTakeoutAddress(loadTakeoutAddressBook(), { kind: 'user' }).address || '当前收货地址';
  const orders: TakeoutOrder[] = [];
  const cleanedContent = cleaned.replace(/\[\[TAKEOUT_ORDER:\s*([^\]]+?)\s*\]\]/gi, (_all, raw: string) => {
    const items = raw.split(/[;；]/).map((part: string, index: number) => {
      const [nameRaw, priceRaw, specRaw] = part.split('|').map(value => value.trim());
      const name = nameRaw?.slice(0, 48) || '';
      const price = Number(priceRaw);
      if (!name || !Number.isFinite(price) || price <= 0 || price > 999) return null;
      return { id: `char-takeout-${Date.now()}-${index}`, name: specRaw ? `${name}（${specRaw.slice(0, 60)}）` : name, price: Math.round(price * 100) / 100 };
    }).filter((item): item is TakeoutOrderItem => !!item).slice(0, 5);
    if (!items.length) return '[外卖订单未能识别]';
    const createdAt = Date.now();
    const deliveryMinutes = 25 + Math.floor(Math.random() * 11);
    const fee = 3 + Math.floor(Math.random() * 5);
    const userAddress = resolveTakeoutAddress(loadTakeoutAddressBook(), { kind: 'user' });
    orders.push({ id: createdAt, target: '用户', items, address: String(location), deliveryDetail: userAddress.detail, deliveryNote: userAddress.note, createdAt, deliveryMinutes, fee, etaAt: createdAt + deliveryMinutes * 60_000, placedBy: 'character', orderedBy, fulfillment: 'meituan_pending' });
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  // 模型偶尔会把它已经说出口的“我给你点好了”当作普通文字，漏掉结构标记。
  // 这层只认明确的完成时措辞，既避免把“我去点”误判成订单，也让卡片不会凭空消失。
  const clearlyOrdered = /(?:给|替|帮).{0,8}(?:点好(?:了)?|点上了|点了|下好了单|下单了|叫好(?:了)?)|(?:已经|刚刚).{0,12}(?:点好(?:了)?|点上了|点了|下好了单|下单了)/.test(cleanedContent);
  if (orders.length === 0 && clearlyOrdered) {
    // 漏结构标记时，不能从角色最后一句硬猜商品；应回看本轮前的用户话，
    // 因为“想吃什么 / 口味”通常正是在那里说清的。
    const recentUserText = conversation.filter(message => message.role === 'user').slice(-5).map(message => String(message.content || '')).reverse().join('。');
    const requestedFood = recentUserText.match(/(?:想吃|想喝|要吃|要喝|想要|给我来|帮我点|点一?[份杯个]?|来一?[份杯个]?)[：：\s]*([^。！？!?\n]{2,42})/)?.[1]?.trim();
    const foodHint = requestedFood || cleanedContent.match(/(?:[\u4e00-\u9fffA-Za-z0-9]{0,10})(?:奶茶|咖啡|拿铁|果茶|柠檬茶|炸鸡|汉堡|披萨|米饭|盖饭|米线|面|粥|甜品|蛋糕|沙拉|水果|药)[\u4e00-\u9fffA-Za-z0-9]{0,10}/)?.[0]?.trim();
    // 用户已说明“饮品 + 口味”但没有重复品名时，至少保留正确品类和口味；
    // 绝不能再把“少冰半糖”单独伪装成一道餐品。
    const drinkSpec = (recentUserText + ' ' + cleanedContent).match(/(?:正常冰|少冰|去冰|热饮|全糖|半糖|少糖|无糖|三分糖|五分糖|七分糖)/g);
    const fallbackItem = foodHint || (drinkSpec?.length ? `饮品（${Array.from(new Set(drinkSpec)).join('、')}）` : '');
    if (!fallbackItem) return { cleanedContent, orders };
    const createdAt = Date.now();
    const userAddress = resolveTakeoutAddress(loadTakeoutAddressBook(), { kind: 'user' });
    orders.push({
      id: createdAt,
      target: '用户',
      items: [{ id: `char-takeout-inferred-${createdAt}`, name: fallbackItem.slice(0, 60), price: 0 }],
      address: String(location),
      deliveryDetail: userAddress.detail,
      deliveryNote: userAddress.note,
      createdAt,
      deliveryMinutes: 30,
      fee: 0,
      etaAt: createdAt + 30 * 60_000,
      placedBy: 'character',
      orderedBy,
      fulfillment: 'meituan_pending',
    });
  }
  return { cleanedContent, orders };
}
