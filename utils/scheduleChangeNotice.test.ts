import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ScheduleChangeNotice from '../components/chat/ScheduleChangeNotice';

describe('ScheduleChangeNotice', () => {
    it('明确展示时段、原计划与新计划，并暴露白框稳定选择器', () => {
        const html = renderToStaticMarkup(React.createElement(ScheduleChangeNotice, {
            detail: {
                charId: 'char-1',
                date: '2026-08-15',
                eventId: 'event-1',
                schedule: {
                    id: 'char-1_2026-08-15',
                    charId: 'char-1',
                    date: '2026-08-15',
                    generatedAt: 1,
                    slots: [],
                },
                changes: [{ startTime: '18:30', before: '健身', after: '去超市' }],
            },
            onDone: () => {},
        }));

        expect(html).toContain('未来日程已调整');
        expect(html).toContain('18:30');
        expect(html).toContain('健身');
        expect(html).toContain('去超市');
        for (const hook of [
            'sully-schedule-change',
            'sully-schedule-change-time',
            'sully-schedule-change-before',
            'sully-schedule-change-after',
            'sully-schedule-change-shine',
        ]) expect(html).toContain(hook);
    });
});
