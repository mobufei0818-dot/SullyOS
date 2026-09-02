import type { MomentsPendingJob, MomentsSyncOutboxItem, MomentsWorkerConfig, MomentsWorkerDiagnostics } from '../types';

export interface MomentsSyncPayload {
  userId: string;
  events: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  receipts: Array<Record<string, unknown>>;
}

const normalizeWorkerUrl = (url: string) => url.trim().replace(/\/+$/, '');

export const isMomentsWorkerReady = (config?: MomentsWorkerConfig | null): config is MomentsWorkerConfig =>
  Boolean(config?.url?.trim());

/** Cloudflare D1 免费额度恢复后，用于识别可以被成功诊断覆盖的旧错误。 */
export const isD1DailyLimitError = (message?: string): boolean =>
  /exceeded\s+D1(?:'s)?\s+free\s+tier\s+daily\s+row\s+(?:read|write)\s+limit/i.test(message || '');

/** 没有 outbox 且没有 pending 任务时，“立即重试”应当得出“无需同步”的成功结论。 */
export const hasPendingMomentsSyncWork = (
  items: MomentsSyncOutboxItem[],
  jobs: MomentsPendingJob[],
): boolean => items.length > 0 || jobs.some(job => job.state === 'pending');

/**
 * 把本地朋友圈 outbox 以幂等批次同步到已部署的 AMSG Worker 的 /moments 路由。
 * Worker 只接收事件/任务摘要，不接触聊天密钥；同步失败直接抛出，调用方保留 outbox 等待下一次重试。
 */
export async function syncMomentsOutbox(config: MomentsWorkerConfig, payload: MomentsSyncPayload): Promise<{ accepted: number; acceptedEventIds: string[]; acceptedTaskIds: string[] }> {
  if (!isMomentsWorkerReady(config)) throw new Error('朋友圈 Worker URL 尚未配置');
  const response = await fetch(`${normalizeWorkerUrl(config.url)}/moments/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.clientToken?.trim() ? { 'X-Client-Token': config.clientToken.trim() } : {}),
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!response.ok) throw new Error(data?.error || `Worker HTTP ${response.status}: ${text.slice(0, 160)}`);
  return {
    accepted: Number(data?.accepted ?? 0),
    acceptedEventIds: Array.isArray(data?.acceptedEventIds) ? data.acceptedEventIds.filter((id: unknown): id is string => typeof id === 'string') : [],
    acceptedTaskIds: Array.isArray(data?.acceptedTaskIds) ? data.acceptedTaskIds.filter((id: unknown): id is string => typeof id === 'string') : [],
  };
}

export async function pullMomentsTasks(config: MomentsWorkerConfig, userId: string, dueBefore = Date.now()): Promise<MomentsPendingJob[]> {
  if (!isMomentsWorkerReady(config)) throw new Error('朋友圈 Worker URL 尚未配置');
  const query = new URLSearchParams({ userId, dueBefore: String(dueBefore) });
  const response = await fetch(`${normalizeWorkerUrl(config.url)}/moments/tasks?${query.toString()}`, {
    headers: { ...(config.clientToken?.trim() ? { 'X-Client-Token': config.clientToken.trim() } : {}) },
  });
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!response.ok) throw new Error(data?.error || `Worker HTTP ${response.status}: ${text.slice(0, 160)}`);
  return Array.isArray(data?.tasks) ? data.tasks as MomentsPendingJob[] : [];
}

export async function pullMomentsDeliveries(config: MomentsWorkerConfig, userId: string): Promise<Array<{ id: string; taskId: string; payload: Record<string, unknown>; createdAt: number }>> {
  if (!isMomentsWorkerReady(config)) throw new Error('朋友圈 Worker URL 尚未配置');
  const query = new URLSearchParams({ userId });
  const response = await fetch(`${normalizeWorkerUrl(config.url)}/moments/deliveries?${query}`, { headers: { ...(config.clientToken?.trim() ? { 'X-Client-Token': config.clientToken.trim() } : {}) } });
  const text = await response.text(); let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!response.ok) throw new Error(data?.error || `Worker HTTP ${response.status}: ${text.slice(0, 160)}`);
  return Array.isArray(data?.deliveries) ? data.deliveries.filter((item: any) => item && typeof item.id === 'string' && item.payload && typeof item.payload === 'object') : [];
}

const postJson = async (config: MomentsWorkerConfig, path: string, body: Record<string, unknown>) => {
  if (!isMomentsWorkerReady(config)) throw new Error('朋友圈 Worker URL 尚未配置');
  const response = await fetch(`${normalizeWorkerUrl(config.url)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(config.clientToken?.trim() ? { 'X-Client-Token': config.clientToken.trim() } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!response.ok) {
    const error = new Error(data?.error || `Worker HTTP ${response.status}: ${text.slice(0, 160)}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return data || {};
};

export async function claimMomentsTask(config: MomentsWorkerConfig, userId: string, taskId: string): Promise<{ claimed: boolean; task?: MomentsPendingJob }> {
  try {
    const data = await postJson(config, '/moments/tasks/claim', { userId, taskId });
    return { claimed: data?.claimed === true, task: data?.task as MomentsPendingJob | undefined };
  } catch (error: any) {
    if (error?.status === 409) return { claimed: false };
    throw error;
  }
}

export async function completeMomentsTask(config: MomentsWorkerConfig, userId: string, taskId: string, state: Extract<MomentsPendingJob['state'], 'done' | 'failed' | 'cancelled'>, error?: string): Promise<void> {
  await postJson(config, '/moments/tasks/complete', { userId, taskId, state, ...(error ? { error } : {}) });
}

export async function acknowledgeMomentsDeliveries(config: MomentsWorkerConfig, userId: string, deliveryIds: string[]): Promise<void> {
  if (!deliveryIds.length) return;
  await postJson(config, '/moments/deliveries/ack', { userId, deliveryIds: deliveryIds.slice(0, 200) });
}

export async function getMomentsWorkerDiagnostics(config: MomentsWorkerConfig, userId: string): Promise<MomentsWorkerDiagnostics> {
  if (!isMomentsWorkerReady(config)) throw new Error('朋友圈 Worker URL 尚未配置');
  const query = new URLSearchParams({ userId });
  const response = await fetch(`${normalizeWorkerUrl(config.url)}/moments/diagnostics?${query}`, {
    headers: { ...(config.clientToken?.trim() ? { 'X-Client-Token': config.clientToken.trim() } : {}) },
  });
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!response.ok) throw new Error(data?.error || `Worker HTTP ${response.status}: ${text.slice(0, 160)}`);
  const counts: MomentsWorkerDiagnostics['counts'] = {};
  for (const row of Array.isArray(data?.counts) ? data.counts : []) {
    if (row && typeof row.state === 'string') counts[row.state as MomentsPendingJob['state']] = Number(row.count) || 0;
  }
  return { counts, recent: Array.isArray(data?.diagnostics) ? data.diagnostics : [], checkedAt: Date.now() };
}

export const outboxToSyncPayload = (items: MomentsSyncOutboxItem[], jobs: MomentsPendingJob[], userId: string): MomentsSyncPayload => {
  const eventItems = items.filter(item => item.type !== 'interaction' || item.payload?.dueAt == null).slice(0, 200);
  const taskItems = items.filter(item => item.type === 'interaction' && item.payload?.dueAt != null).slice(0, 200);
  const jobItems = jobs.filter(job => ['pending', 'cancelled', 'done', 'failed'].includes(job.state)).slice(0, Math.max(0, 200 - taskItems.length));
  return {
  userId,
  events: eventItems.map(item => ({ id: item.id, type: item.type, payload: item.payload, createdAt: item.createdAt })),
  tasks: [
    ...jobItems.map(job => ({
      id: job.id, type: job.type, actorId: job.actorId || null, postId: job.postId || null,
      dueAt: job.dueAt, state: job.state, payload: job.payload || {}, threadVersion: job.threadVersion || 1,
      updatedAt: job.updatedAt || job.createdAt,
    })),
    ...taskItems.map(item => ({ id: item.id, type: 'interaction', ...(item.payload || {}), createdAt: item.createdAt })),
  ],
  receipts: [],
  };
};
