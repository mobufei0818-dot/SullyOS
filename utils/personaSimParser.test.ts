import { describe, expect, it } from 'vitest';
import { parsePersonaScriptApiResponse, parsePersonaScriptResponse } from './personaSimParser';

const beats = `[
  { "kind": "thought", "monologue": "其实有点在意。" },
  { "kind": "end", "time": "23:40" }
]`;

describe('personaSimParser', () => {
  it('兼容代码块、前后说明和尾逗号', () => {
    const result = parsePersonaScriptResponse(`先给你结果：\n\`\`\`json
      { "title": "周二", "summary": "夜深了。", "beats": ${beats}, }
      \`\`\`\n以上是完整演出。`);

    expect(result).toMatchObject({ title: '周二', summary: '夜深了。' });
    expect(result?.beats.map(beat => beat.kind)).toEqual(['thought', 'end']);
  });

  it('兼容 script/result/data 外层包装', () => {
    const result = parsePersonaScriptResponse(JSON.stringify({
      result: { data: { script: { title: '包装演出', summary: '', beats: JSON.parse(beats) } } },
    }));

    expect(result?.title).toBe('包装演出');
    expect(result?.beats.at(-1)?.kind).toBe('end');
  });

  it('修复模型写进 JSON 字符串里的原始换行', () => {
    const result = parsePersonaScriptResponse(`{
      "title": "换行",
      "summary": "",
      "beats": [
        { "kind": "thought", "monologue": "第一句
第二句" },
        { "kind": "end" }
      ]
    }`);

    expect(result?.beats[0].monologue).toBe('第一句\n第二句');
  });

  it('从 reasoning_content 或分段 content 中提取正文', () => {
    const reasoningResult = parsePersonaScriptApiResponse({
      choices: [{ message: { content: '', reasoning_content: `{ "title": "思考模型", "summary": "", "beats": ${beats} }` } }],
    });
    const segmentedResult = parsePersonaScriptApiResponse({
      choices: [{ message: { content: [{ type: 'text', text: `{ "title": "分段正文", "summary": "", "beats": ${beats} }` }] } }],
    });

    expect(reasoningResult.script?.title).toBe('思考模型');
    expect(segmentedResult.script?.title).toBe('分段正文');
  });

  it('没有有效 beats 时拒绝播放', () => {
    expect(parsePersonaScriptResponse('{ "title": "空", "beats": [] }')).toBeNull();
    expect(parsePersonaScriptResponse('模型拒绝生成这段内容')).toBeNull();
  });
});
