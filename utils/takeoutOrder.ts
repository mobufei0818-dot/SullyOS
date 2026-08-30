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
  createdAt: number;
  deliveryMinutes: number;
  fee: number;
  etaAt: number;
  placedBy?: 'user' | 'character';
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
  const total = subtotal + order.fee;
  const status = isMeituanPending ? '待在美团确认' : '已下单';
  const note = isMeituanPending ? `送至：${escapeHtml(order.address)}<br/>请在美团外卖确认门店、价格和配送时间后完成付款` : `送至：${escapeHtml(order.address)}<br/>预计约 ${order.deliveryMinutes} 分钟送达，请留意取餐提醒`;
  const deliveryRow = isMeituanPending ? `<div style="margin-top:7px;font-size:12px;color:#64594f">实际价格、优惠和配送费以美团页面为准</div>` : `<div style="margin-top:7px;display:flex;justify-content:space-between;font-size:12px;color:#64594f"><span>配送费</span><span>¥${order.fee}</span></div>`;
  const totalRow = isMeituanPending ? `<div style="margin-top:12px;font-size:12px;color:#76695f">预估商品小计 ¥${subtotal}</div>` : `<div style="margin-top:12px;display:flex;align-items:baseline;justify-content:space-between"><span style="font-size:12px;color:#76695f">实付</span><span style="font-size:21px;font-weight:800;color:#e76522">¥${total}</span></div>`;
  const html = `<div style="width:278px;box-sizing:border-box;overflow:hidden;border-radius:5px;background:#fffdfa;color:#242424;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;box-shadow:0 8px 22px rgba(56,40,22,.12)"><div style="height:7px;background:repeating-linear-gradient(135deg,#f5e7d3 0 5px,#fffdfa 5px 10px)"></div><div style="padding:16px 17px 14px"><div style="display:flex;align-items:center;justify-content:space-between"><div style="font-size:10px;letter-spacing:1.8px;color:#a17c5b">外卖 · ${isMeituanPending ? '美团待确认单' : '电子小票'}</div><div style="border:1px solid #e8c9a4;border-radius:999px;padding:3px 7px;font-size:10px;color:#c66b2b">${status}</div></div><div style="margin-top:9px;font-size:19px;font-weight:750;letter-spacing:.2px">外卖订单</div><div style="margin-top:4px;font-size:11px;color:#84786d">${escapeHtml(cardTarget)}${isMeituanPending ? ' · 角色为你挑好了' : ` · 预计 ${arrivalText} 送达`}</div><div style="margin-top:12px;border-top:1px dashed #dbcdbd"></div><div style="padding:2px 0 4px">${rows}</div><div style="border-top:1px dashed #dbcdbd"></div><div style="margin-top:10px;display:flex;justify-content:space-between;font-size:12px;color:#64594f"><span>商品小计</span><span>¥${subtotal}</span></div>${deliveryRow}${totalRow}<div style="margin-top:12px;padding-top:10px;border-top:1px dashed #dbcdbd;font-size:11px;line-height:1.55;color:#8c8177">${note}</div></div><div style="height:7px;background:repeating-linear-gradient(45deg,#f5e7d3 0 5px,#fffdfa 5px 10px)"></div></div>`;
  return { html, textPreview: isMeituanPending ? `角色为你挑选了外卖：${order.items.map(item => item.name).join('、')}；送至${order.address}。此单尚未在美团外卖完成下单，实际门店、价格、配送费和送达时间以美团页面为准。` : `外卖订单：${cardTarget}；商品：${order.items.map(item => item.name).join('、')}；预计 ${arrivalText} 送达（${order.deliveryMinutes}分钟后），当前尚未送达。配送费${order.fee}元。` };
}

/**
 * 角色确认下单后输出的紧凑指令：
 * [[TAKEOUT_ORDER: 商品名|价格|规格; 商品名|价格|规格]]
 * 仅由程序生成订单，模型输出的文字不会直接成为卡片样式。
 */
export function extractRoleTakeoutOrders(content: string): { cleanedContent: string; orders: TakeoutOrder[] } {
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
    orders.push({ id: createdAt, target: '用户', items, address: String(location), createdAt, deliveryMinutes, fee, etaAt: createdAt + deliveryMinutes * 60_000, placedBy: 'character', fulfillment: 'meituan_pending' });
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { cleanedContent, orders };
}
