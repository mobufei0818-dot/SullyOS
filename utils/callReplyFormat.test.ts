import { describe, expect, it } from 'vitest';
import { extractAvatarPerformance, inferAvatarPerformanceFromText, resolveAvatarPerformance } from './avatarPerformance';
import { parseCallAssistantMessage, stripCallTextFormatting } from './callReplyFormat';

describe('视频通话回复分流', () => {
  it('把原生 reasoning_content 存为思维链，不混进台词', () => {
    expect(parseCallAssistantMessage({ content: '喂，听得到吗？', reasoning_content: '刚接起来，先确认信号。' }, true)).toEqual({
      text: '喂，听得到吗？',
      thinkingChain: '刚接起来，先确认信号。',
    });
  });

  it('剥掉闭合和未闭合 think 标签，且只在开关开启时返回思维链', () => {
    const raw = '<think>先别笑得太明显。</think>\n[[AVATAR: emotion=happy; gesture=wave; camera=push-in; gaze=viewer; intensity=0.85]]\n(chuckle) 你来啦。';
    const parsed = parseCallAssistantMessage({ content: raw }, true);
    expect(parsed.text).toBe('(chuckle) 你来啦。');
    expect(parsed.thinkingChain).toBe('先别笑得太明显。');
    expect(parsed.performance).toMatchObject({ emotion: 'happy', gesture: 'wave', camera: 'push-in', gaze: 'viewer', intensity: 0.85 });
    expect(parseCallAssistantMessage({ content: '<think>秘密</think>正文' }, false)).toEqual({ text: '正文' });
  });

  it('兼容 content 分块与 reasoning-only 中转', () => {
    expect(parseCallAssistantMessage({ content: [{ type: 'text', text: '分块正文' }] }, true).text).toBe('分块正文');
    expect(parseCallAssistantMessage({ content: '', reasoning_content: '代理塞错位置的最终台词' }, true)).toEqual({ text: '代理塞错位置的最终台词' });
  });

  it('演出参数做枚举归一与强度限幅', () => {
    const out = extractAvatarPerformance('[[PERFORMANCE: expression=joy action=agree shot=close-up look=camera energy=2]]\n好。');
    expect(out.text).toBe('好。');
    expect(out.direction).toEqual({ emotion: 'happy', gesture: 'nod', camera: 'close', gaze: 'viewer', intensity: 1 });
    expect(resolveAvatarPerformance(undefined, 'surprised').emotion).toBe('surprised');
    expect(extractAvatarPerformance('[[AVATAR: emotion=happy; model_action=motion-3]]\n好。').direction?.modelAction).toBe('motion-3');
  });

  it('朗读前去掉 Markdown 外壳但保留正文和语音标签', () => {
    expect(stripCallTextFormatting('## **别怕**\n- 我在。\n<语音 emotion="calm">I am here.</语音>'))
      .toBe('别怕\n我在。\n<语音 emotion="calm">I am here.</语音>');
  });

  it('模型漏演出标签时可从台词做本地动作兜底', () => {
    expect(inferAvatarPerformanceFromText('喂，你终于来啦。')).toMatchObject({ emotion: 'happy', gesture: 'wave' });
    expect(inferAvatarPerformanceFromText('啊？你说真的？')).toMatchObject({ emotion: 'surprised', gesture: 'tilt', camera: 'push-in' });
    expect(inferAvatarPerformanceFromText('……对不起，我今天有点难过。')).toMatchObject({ emotion: 'sad', gesture: 'shy', gaze: 'down' });
  });
});
