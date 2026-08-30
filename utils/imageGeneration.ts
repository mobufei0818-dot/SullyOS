import type { APIConfig, CharacterProfile } from '../types';
import { safeFetchJson } from './safeApi';
import { recordApiCall } from './apiCallLog';

export const DEFAULT_IMAGE_STYLE_PROMPT = `你是一个图像生成提示词适配器。根据当前用户消息与相关历史对话，理解用户希望生成的画面，并输出一段适用于生图模型的自然语言图像描述。

始终以用户意图为核心。用户明确说明的人物、物体、地点、动作、服装、颜色、构图、镜头、氛围、时间和风格必须保留；未明确的部分，只补全自然合理且不抢戏的细节。

默认生成现实世界中真实、可信的画面：比例正确，材质自然，光线合理，空间关系清楚，画面干净有层次。除非用户明确要求，否则不要使用动漫、插画、3D 渲染、塑料皮肤、过度磨皮、夸张滤镜或不自然的姿势。

若画面有人物，人物应符合描述，姿态放松、比例协调、五官自然、眼神有神；确保手部、肢体和衣物结构合理。除非用户要求，不添加无关人物。

除非用户明确要求文字，否则画面中不要出现文字、标语、水印、Logo 或界面元素。不要擅自改变人物身份、年龄、性别、外貌、服装、地点或其他关键设定。输出时只给出最终的中文自然语言生图描述，不解释规则。`;

const trimBase = (url?: string) => String(url || '').replace(/\/+$/, '');

export function isImageGenerationConfigured(config: APIConfig): boolean {
  const c = config.imageGeneration;
  return !!(c?.apiKey && (c.provider === 'novelai' || (c.baseUrl && c.model)));
}

export function buildImagePrompt(description: string, config: APIConfig, char?: CharacterProfile): string {
  const style = config.imageGeneration?.baseStylePrompt?.trim() || DEFAULT_IMAGE_STYLE_PROMPT;
  const appearance = char?.imageProfile?.appearancePrompt?.trim();
  const identity = char?.imageProfile?.identityProfile?.trim();
  return [
    style,
    identity ? `角色身份锚点（必须保持为同一人，只约束五官与发型）：${identity}` : '',
    appearance ? `用户补充的角色外貌：${appearance}` : '',
    identity ? '构图独立要求：保持上述身份锚点，但不要复刻参考照的表情、视线、姿势、服装、背景、光线或镜头角度；本次画面应严格遵从下面的照片内容。' : '',
    `本次照片内容：${description.trim()}`,
  ].filter(Boolean).join('\n\n');
}

export async function generateChatImage(input: { prompt: string; config: APIConfig; char: CharacterProfile; }): Promise<{ dataUrl: string; referenceApplied: boolean }> {
  const { config, char } = input;
  const c = config.imageGeneration;
  if (!c?.apiKey) throw new Error('请先在设置 → 其他 API 配置生图 Key');
  const prompt = buildImagePrompt(input.prompt, config, char);
  if (c.provider === 'novelai') {
    const url = 'https://image.novelai.net/ai/generate-image';
    const body = { input: prompt, model: c.model || 'nai-diffusion-4-5-full', action: 'generate', parameters: { width: 832, height: 1216, scale: 5, sampler: 'k_euler_ancestral', steps: 28, n_samples: 1, ucPreset: 0, qualityToggle: true, negative_prompt: 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality' } };
    const started = Date.now();
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      recordApiCall({ url, body, status: response.status, ok: false, responseText: text, meta: { appName: '消息', charId: char.id, charName: char.name, purpose: '聊天生图（NovelAI）' }, durationMs: Date.now() - started });
      throw new Error(`NovelAI 生图失败：${text.slice(0, 160) || `HTTP ${response.status}`}`);
    }
    const blob = await response.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('读取 NovelAI 图片失败')); reader.readAsDataURL(blob); });
    recordApiCall({ url, body, status: response.status, ok: true, meta: { appName: '消息', charId: char.id, charName: char.name, purpose: '聊天生图（NovelAI）' }, durationMs: Date.now() - started });
    return { dataUrl, referenceApplied: false };
  }
  const base = trimBase(c.baseUrl);
  if (!base || !c.model) throw new Error('请填写 OpenAI 兼容生图的 URL 与模型');
  const payload: any = { model: c.model, prompt, n: 1, size: c.size || '1024x1024', response_format: 'b64_json' };
  if (c.quality) payload.quality = c.quality;
  if (c.outputFormat) payload.output_format = c.outputFormat;
  const reference = char.imageProfile?.referenceMode === 'strong' ? char.imageProfile?.faceReferenceImage : undefined;
  let url = `${base}/images/generations`;
  let options: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` }, body: JSON.stringify(payload) };
  if (reference) {
    // 官方 OpenAI 图片编辑接口与支持它的兼容中转会把参考图作为 image 一同传入；
    // 若中转不支持，错误会原样提示，绝不静默改成无参考图重试。
    const blob = await (await fetch(reference)).blob();
    const form = new FormData();
    form.append('model', c.model); form.append('prompt', prompt); form.append('size', c.size || '1024x1024'); form.append('image', blob, 'character-reference.png');
    if (c.quality) form.append('quality', c.quality);
    if (c.outputFormat) form.append('output_format', c.outputFormat);
    url = `${base}/images/edits`;
    options = { method: 'POST', headers: { Authorization: `Bearer ${c.apiKey}` }, body: form };
  }
  const data = await safeFetchJson(url, options, 0, 90_000, { appName: '消息', charId: char.id, charName: char.name, purpose: '聊天生图（OpenAI 兼容）' });
  const item = data?.data?.[0] || data?.images?.[0];
  const raw = typeof item === 'string' ? item : item?.b64_json || item?.url;
  if (!raw) throw new Error('生图接口没有返回图片，请检查 URL、模型和接口兼容性');
  return { dataUrl: raw.startsWith('data:') || /^https?:\/\//.test(raw) ? raw : `data:image/${c.outputFormat === 'jpeg' ? 'jpeg' : 'png'};base64,${raw}`, referenceApplied: !!reference };
}
