/**
 * 云端 client_state 的「删行」：特性探测、旁路存储的键前缀、存量空壳的判定与切批。
 *
 * worker 把一条 push 装不下的大内容（思考链 / 情绪评估 / 小红书会话）旁路存进角色的
 * client_state 命名空间，客户端取回后把那一行清掉。amsg-server 2.6.0-next.27 起
 * `PUT /client-state` 认 `value: null` 表示删掉这个 key（连大值的切片行一起），
 * 特性位是 `client-state-delete`；更老的 worker 收到 null 会按 INVALID_STATE_VALUE
 * 逐条拒掉，只能写空串留一个几字节的空壳。
 *
 * 这份文件只做不联网的判断，联网那半截在 activeMsgClient（clearClientStateValue /
 * clearNamespaceValuesOrThrow / 存量空壳清理）。
 */

/** worker 认 `value: null` 删行的能力位（GET /capabilities 的 features）。名字由上游定义，这里只认它。 */
export const CLIENT_STATE_DELETE_FEATURE = 'client-state-delete';

/**
 * 这台 worker 认不认删行。探不到 / 老 worker 一律 false，那一档照旧写空串。
 * 前端只在握手时判一次，之后读全局配置里的存量（见 activeMsgClient 的 isClientStateDeleteReady）。
 */
export const supportsClientStateDelete = (features: string[] | null | undefined): boolean =>
  Array.isArray(features) && features.includes(CLIENT_STATE_DELETE_FEATURE);

/**
 * 旁路存储的三个键前缀。键名由各自的工厂函数拼出来（`<前缀><uuid>`），其中两个在
 * worker 侧、前端 import 不到，这里抄一份字面量：
 *   reasoning:      思考链      worker/amsg/src/index.ts 的 amsgReasoningKey
 *   emotion_update: 情绪评估    worker/amsg/src/emotionEval.ts 的 amsgEmotionUpdateKey
 *   xhs_session:    小红书会话  utils/amsgFirePack.ts 的 amsgXhsSessionKey
 * 那三处改了这里要跟着改。
 */
export const AMSG_SIDECHANNEL_KEY_PREFIXES = ['reasoning:', 'emotion_update:', 'xhs_session:'] as const;

/** 这个键是不是旁路存储的（按上面的前缀认）。 */
export const isSidechannelKey = (key: string): boolean =>
  AMSG_SIDECHANNEL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));

/**
 * 从一个命名空间读回来的条目里挑出旁路存储的空壳：键带上面的前缀、值是空串
 * （worker 认删行之前，取回内容后写空留下的那种）。
 *
 * 别的键一律不碰——fire_pack / self_log 这类长期状态就算是空的也不归这里管，
 * 它们各有各的写入时机，删掉反而要等下一轮同步才补得回来。
 */
export const pickSidechannelShellKeys = (
  entries: ReadonlyArray<{ key?: unknown; value?: unknown }> | null | undefined,
): string[] => {
  const keys: string[] = [];
  for (const entry of entries ?? []) {
    if (typeof entry?.key !== 'string') continue;
    if (!isSidechannelKey(entry.key) || entry.value !== '') continue;
    keys.push(entry.key);
  }
  return keys;
};

/** 上游一次 PUT /client-state 最多收的条目数（amsg-server 的 MAX_STATE_ENTRIES_PER_BATCH），超了要自己切片。 */
export const CLIENT_STATE_PUT_BATCH_MAX = 200;

/** 按单批上限把条目切成若干批（空数组切出来就是零批）。 */
export const chunkClientStateEntries = <T>(items: readonly T[], size = CLIENT_STATE_PUT_BATCH_MAX): T[][] => {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
};
