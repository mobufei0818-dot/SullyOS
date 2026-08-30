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
};

const ORDER_STORAGE_KEY = 'nmj-takeout-orders';
const ROLE_ORDER_INTENT_STORAGE_KEY = 'nmj-takeout-role-order-intents';
const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char] || char));
const STORE_PREFIX_RE = /^(?:古茗|蜜雪冰城|霸王茶姬|喜茶|奈雪(?:的茶)?|瑞幸|星巴克|库迪|茶百道|沪上阿姨|一点点|coco|书亦烧仙草|益禾堂|快乐柠檬)\s*的\s*/i;

type TakeoutConversationMessage = { role?: string; content?: string; id?: string | number; timestamp?: number };

/**
 * 角色为用户生成订单前必须已经得到明确授权。
 *
 * 只认可两条链路：
 * 1. 用户这一句明确要求角色点/买/下单；
 * 2. 角色上一句明确提议替用户点外卖，用户这一句明确答应。
 *
 * “想吃”“想喝”“饿了”只是聊天内容，绝不能当作下单授权。
 */
function resolveConfirmedRoleOrderIntent(conversation: TakeoutConversationMessage[]): { key: string } | null {
  const lastUserIndex = [...conversation].map(message => message.role).lastIndexOf('user');
  if (lastUserIndex < 0) return null;
  const userMessage = conversation[lastUserIndex];
  const userText = String(userMessage.content || '').replace(/\s+/g, ' ').trim();
  if (!userText) return null;
  const userKey = userMessage.id != null
    ? `id:${String(userMessage.id)}`
    : `text:${userText}|at:${String(userMessage.timestamp || '')}`;

  // 用户直接要求角色代为下单。仅表达食欲不算。
  if (/(?:帮我|给我|替我|麻烦你|请你).{0,12}(?:点|买|下单)|(?:你来|你给我|你帮我).{0,12}(?:点|买|下单)/u.test(userText)) {
    return { key: `user-request:${userKey}` };
  }

  // 角色先主动提出“我给你点外卖”，用户再说好/确认/下吧，才允许这一轮生成订单。
  const userApproved = /^(?:好(?:的|呀|啊)?|行(?:啊|呀)?|可以|确认|就这个|要(?:的|吧)?|点吧|下吧|买吧|麻烦你了|拜托了)(?:[。！!，,\s]|$)/u.test(userText);
  if (!userApproved) return null;
  const priorAssistant = conversation.slice(0, lastUserIndex).reverse().find(message => message.role === 'assistant');
  const proposal = String(priorAssistant?.content || '').replace(/\s+/g, ' ').trim();
  const roleProposedOrder = /(?:要不要|要不|不如).{0,18}(?:给你|帮你).{0,12}(?:点|买|下单)|(?:我来|我给你|我帮你).{0,18}(?:点|买|下单).{0,18}(?:外卖|吃的|喝的|餐|奶茶|咖啡|饮品|饭|面|粥|水果)/u.test(proposal);
  return roleProposedOrder ? { key: `role-proposal:${userKey}` } : null;
}

function claimRoleOrderIntent(intentKey: string): boolean {
  if (typeof localStorage === 'undefined') return true;
  try {
    const prior = JSON.parse(localStorage.getItem(ROLE_ORDER_INTENT_STORAGE_KEY) || '[]');
    const keys = Array.isArray(prior) ? prior.filter((value): value is string => typeof value === 'string').slice(-60) : [];
    if (keys.includes(intentKey)) return false;
    localStorage.setItem(ROLE_ORDER_INTENT_STORAGE_KEY, JSON.stringify([...keys, intentKey].slice(-60)));
  } catch {
    // 存储异常时宁可继续生成一张，也不能让订单流程整体失效。
  }
  return true;
}

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
  const arrivalText = new Date(order.etaAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const cardTarget = takeoutCardTarget(order.target);
  const rows = order.items.map(item => `<div style="display:flex;justify-content:space-between;gap:12px;margin-top:10px;font-size:13px;line-height:1.45"><span style="flex:1">${escapeHtml(item.name)}</span><b style="white-space:nowrap;font-weight:600">¥${item.price}</b></div>`).join('');
  const subtotal = order.items.reduce((sum, item) => sum + item.price, 0);
  const total = subtotal + order.fee;
  const html = `<div style="width:278px;box-sizing:border-box;overflow:hidden;border-radius:5px;background:#fffdfa;color:#242424;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;box-shadow:0 8px 22px rgba(56,40,22,.12)"><div style="height:7px;background:repeating-linear-gradient(135deg,#f5e7d3 0 5px,#fffdfa 5px 10px)"></div><div style="padding:16px 17px 14px"><div style="display:flex;align-items:center;justify-content:space-between"><div style="font-size:10px;letter-spacing:1.8px;color:#a17c5b">外卖 · 电子小票</div><div style="border:1px solid #e8c9a4;border-radius:999px;padding:3px 7px;font-size:10px;color:#c66b2b">已下单</div></div><div style="margin-top:9px;font-size:19px;font-weight:750;letter-spacing:.2px">外卖订单</div><div style="margin-top:4px;font-size:11px;color:#84786d">${escapeHtml(cardTarget)} · 预计 ${arrivalText} 送达</div><div style="margin-top:12px;border-top:1px dashed #dbcdbd"></div><div style="padding:2px 0 4px">${rows}</div><div style="border-top:1px dashed #dbcdbd"></div><div style="margin-top:10px;display:flex;justify-content:space-between;font-size:12px;color:#64594f"><span>商品小计</span><span>¥${subtotal}</span></div><div style="margin-top:7px;display:flex;justify-content:space-between;font-size:12px;color:#64594f"><span>配送费</span><span>¥${order.fee}</span></div><div style="margin-top:12px;display:flex;align-items:baseline;justify-content:space-between"><span style="font-size:12px;color:#76695f">实付</span><span style="font-size:21px;font-weight:800;color:#e76522">¥${total}</span></div><div style="margin-top:12px;padding-top:10px;border-top:1px dashed #dbcdbd;font-size:11px;line-height:1.55;color:#8c8177">送至：${escapeHtml(order.address)}<br/>预计约 ${order.deliveryMinutes} 分钟送达，请留意取餐提醒</div></div><div style="height:7px;background:repeating-linear-gradient(45deg,#f5e7d3 0 5px,#fffdfa 5px 10px)"></div></div>`;
  return { html, textPreview: `外卖订单：${cardTarget}；商品：${order.items.map(item => item.name).join('、')}；预计 ${arrivalText} 送达（${order.deliveryMinutes}分钟后），当前尚未送达。配送费${order.fee}元。` };
}

/**
 * 角色确认下单后输出的紧凑指令：
 * [[TAKEOUT_ORDER: 商品名|价格|规格; 商品名|价格|规格]]
 * 仅由程序生成订单，模型输出的文字不会直接成为卡片样式。
 */
export function extractRoleTakeoutOrders(content: string, conversation: TakeoutConversationMessage[] = []): { cleanedContent: string; orders: TakeoutOrder[] } {
  let cleaned = content.replace(/\[\[TAKEOUT_ADDRESS:\s*([^\]]+?)\s*\]\]/gi, (_all, raw: string) => {
    const [nameRaw, addressRaw, modeRaw, mappedRaw] = raw.split('|').map(value => value.trim());
    // This directive is only emitted after the user has explicitly confirmed a travel/current address in conversation.
    if (!nameRaw) return '';
    saveConfirmedUserTakeoutAddress({ name: nameRaw.slice(0, 30), address: (addressRaw || '').slice(0, 120), mode: modeRaw, mappedAddress: (mappedRaw || '').slice(0, 120) });
    return '';
  });
  const location = resolveTakeoutAddress(loadTakeoutAddressBook(), { kind: 'user' }).address || '当前收货地址';
  const orders: TakeoutOrder[] = [];
  const confirmedIntent = resolveConfirmedRoleOrderIntent(conversation);
  const cleanedContent = cleaned.replace(/\[\[TAKEOUT_ORDER:\s*([^\]]+?)\s*\]\]/gi, (_all, raw: string) => {
    // 标记不是授权本身。没有获得明确点单授权时，静默剥掉模型误输出的标记，绝不下单。
    if (!confirmedIntent) return '';
    // 同一轮回复被重放时，结构标记也只能生成一次。
    const markerKey = `marker:${confirmedIntent.key}:${raw.trim()}`;
    if (!claimRoleOrderIntent(markerKey)) return '';
    claimRoleOrderIntent(confirmedIntent.key);
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
    orders.push({ id: createdAt, target: '用户', items, address: String(location), deliveryDetail: userAddress.detail, deliveryNote: userAddress.note, createdAt, deliveryMinutes, fee, etaAt: createdAt + deliveryMinutes * 60_000, placedBy: 'character' });
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();

  return { cleanedContent, orders };
}
