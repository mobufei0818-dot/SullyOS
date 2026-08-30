import { describe, expect, it } from 'vitest';
import {
    buildInPersonContinueInstruction,
    buildStoryContinueInstruction,
    MEETING_CONTINUE_DISPLAY_TEXT,
} from './meetingContinue';

describe('meeting continue instructions', () => {
    it('keeps the saved turn compact while framing companionship as real co-presence', () => {
        const prompt = buildInPersonContinueInstruction('阿明', '小白');

        expect(MEETING_CONTINUE_DISPLAY_TEXT).toBe('（继续）');
        expect(prompt).toContain('阿明没有主动说话');
        expect(prompt).toContain('仍然真实地待在同一物理空间');
        expect(prompt).toContain('面对面共处');
        expect(prompt).toContain('加强真实陪伴感');
        expect(prompt).toContain('不要擅自替阿明补写新的主动行为');
    });

    it('hands plot initiative back without bypassing the active native preset', () => {
        const prompt = buildStoryContinueInstruction('林夏');

        expect(prompt).toContain('林夏没有新增主动行为');
        expect(prompt).toContain('当前剧情已经启用的原生预设');
        expect(prompt).toContain('文风、叙事视角、格式规则、转述档位');
        expect(prompt).toContain('“用户执笔权”边界');
        expect(prompt).toContain('其他角色的自身目标');
        expect(prompt).toContain('不要切换成普通聊天');
    });
});
