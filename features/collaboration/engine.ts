import { extractContent, safeFetchJson } from '../../utils/safeApi';
import { buildCollaborationModelMessages } from './context';
import type { CollaborationApiProfile, CollaborationContextMessage, CollaborationMakerKind, CollaborationMessage } from './types';
import { parseCollaborationReply, visibleCollaborationStreamText, type ParsedCollaborationReply } from './reasoning';

export const isCollaborationApiConfigured = (profile: CollaborationApiProfile): boolean => (
  !!profile.baseUrl.trim() && !!profile.model.trim()
);

export interface RunCollaborationTurnInput {
  profile: CollaborationApiProfile;
  contextSnapshot: string;
  messages: CollaborationMessage[];
  signal?: AbortSignal;
  onDelta?: (fullText: string) => void;
  makerKind?: CollaborationMakerKind;
  chatContextSnapshot?: CollaborationContextMessage[];
  thinkingEnabled?: boolean;
  turnContext?: string;
}

export const runCollaborationTurn = async ({
  profile,
  contextSnapshot,
  messages,
  signal,
  onDelta,
  makerKind,
  chatContextSnapshot,
  thinkingEnabled,
  turnContext,
}: RunCollaborationTurnInput): Promise<ParsedCollaborationReply> => {
  if (!isCollaborationApiConfigured(profile)) throw new Error('请先配置这个协同模式使用的 API');
  const baseUrl = profile.baseUrl.trim().replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (profile.apiKey.trim()) headers.Authorization = `Bearer ${profile.apiKey.trim()}`;
  const requestBody: Record<string, unknown> = {
    model: profile.model.trim(),
    messages: buildCollaborationModelMessages(contextSnapshot, messages, makerKind, chatContextSnapshot, turnContext),
    temperature: Math.max(0, Math.min(2, Number(profile.temperature) || 0.7)),
    stream: profile.stream,
  };
  if (thinkingEnabled) {
    const model = String(requestBody.model || '');
    if (/^claude-/i.test(model) && !/-thinking$/i.test(model)) requestBody.model = `${model}-thinking`;
    requestBody.thinking = { type: 'enabled', budget_tokens: 4000 };
    requestBody.reasoning_effort = 'medium';
    requestBody.extra_body = { thinking: { type: 'enabled', budget_tokens: 4000 } };
    delete requestBody.temperature;
  }
  const data = await safeFetchJson(
    `${baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify(requestBody),
    },
    0,
    0,
    { appId: 'collaboration', purpose: '协同工作' },
    profile.stream && onDelta
      ? { onDelta: (_delta, fullText) => onDelta(visibleCollaborationStreamText(fullText)) }
      : undefined,
  );
  const parsed = parseCollaborationReply(data);
  if (!parsed.content) throw new Error('API 没有返回可用内容');
  return parsed;
};

const collaborationMemoryTranscript = (messages: CollaborationMessage[]): string => {
  const rows = messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => {
      const attachments = (message.attachments || []).map(attachment => {
        const excerpt = attachment.extractedText?.trim().slice(0, 4_000);
        return excerpt ? `\n[文件：${attachment.name}]\n${excerpt}` : `\n[文件：${attachment.name}]`;
      }).join('');
      return `${message.role === 'user' ? '用户' : '角色'}：${message.content}${attachments}`;
    });
  return rows.join('\n\n').slice(-100_000);
};

/** 归档时生成一条可进入神经链接/记忆宫殿的第一人称经历。 */
export const summarizeCollaborationForMemory = async (input: {
  profile: CollaborationApiProfile;
  characterName: string;
  userName: string;
  sessionTitle: string;
  messages: CollaborationMessage[];
  signal?: AbortSignal;
}): Promise<string> => {
  const { profile, characterName, userName, sessionTitle, messages, signal } = input;
  if (!isCollaborationApiConfigured(profile)) throw new Error('当前协同模式没有可用的总结 API');
  const transcript = collaborationMemoryTranscript(messages);
  if (!transcript.trim()) throw new Error('这个窗口还没有可以总结的对话');
  const baseUrl = profile.baseUrl.trim().replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (profile.apiKey.trim()) headers.Authorization = `Bearer ${profile.apiKey.trim()}`;
  const data = await safeFetchJson(
    `${baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: profile.model.trim(),
        stream: false,
        temperature: 0.25,
        messages: [
          {
            role: 'system',
            content: `你正在为 ${characterName} 整理一条长期记忆。只输出一段 60～180 字的中文第一人称经历，不要标题、日期、列表、引号或 Markdown。必须写清我和 ${userName} 一起做了什么、产出了什么或作出了什么关键决定；有明确的感受、偏好或关系意义时也要保留。不能写“协同窗口”“会话记录”“模型”“提示词”，不要虚构没有发生的结果。`,
          },
          {
            role: 'user',
            content: `任务标题：${sessionTitle}\n\n请把以下经历总结成一条我真正会记住的事情：\n\n${transcript}`,
          },
        ],
      }),
    },
    0,
    120_000,
    { appId: 'collaboration', purpose: '协同归档记忆总结' },
  );
  const summary = extractContent(data)
    .replace(/^```[^\n]*\n?|```$/g, '')
    .replace(/^[“”"'【]|[“”"'】]$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!summary) throw new Error('API 没有生成可用的记忆总结');
  return summary.slice(0, 500);
};
