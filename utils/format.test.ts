import { describe, it, expect } from 'vitest';
import { roundMoney, sumMoney, formatMoney, formatHours } from './format';

describe('金额收敛到分位', () => {
    it('浮点求和的尾巴被抹掉', () => {
        // 记账里真实出现过的一组流水：直接 + 会得到 49.85999999999999
        const raw = [7.9, 12.9, 11.36, 11.9, 5.8].reduce((s, n) => s + n, 0);
        expect(String(raw)).toContain('49.859999');
        expect(sumMoney([7.9, 12.9, 11.36, 11.9, 5.8])).toBe(49.86);
        expect(formatMoney(raw)).toBe('49.86');
    });

    it('经典 0.1 + 0.2', () => {
        expect(sumMoney([0.1, 0.2])).toBe(0.3);
        expect(formatMoney(0.1 + 0.2)).toBe('0.3');
    });

    it('整数不带小数点，一位小数保持一位', () => {
        expect(formatMoney(100)).toBe('100');
        expect(formatMoney(7.9)).toBe('7.9');
        expect(formatMoney(11.36)).toBe('11.36');
    });

    it('超过两位小数按四舍五入截到分', () => {
        expect(formatMoney(1.239)).toBe('1.24');
        expect(roundMoney(1.234)).toBe(1.23);
    });

    it('空列表和坏值不炸', () => {
        expect(sumMoney([])).toBe(0);
        expect(formatMoney(NaN)).toBe('0');
        expect(formatMoney(Infinity)).toBe('0');
        expect(sumMoney([1.5, NaN as unknown as number, 2])).toBe(3.5);
    });

    it('负数（退款）同样收敛', () => {
        expect(sumMoney([49.86, -7.9])).toBe(41.96);
        expect(formatMoney(-0.1 - 0.2)).toBe('-0.3');
    });
});

describe('分钟转小时显示', () => {
    it('整档不带小数点', () => {
        expect(formatHours(60)).toBe('1');
        expect(formatHours(120)).toBe('2');
        expect(formatHours(1440)).toBe('24');
    });

    it('除不尽的档位收到一位小数', () => {
        expect(String(100 / 60)).toContain('1.6666');
        expect(formatHours(100)).toBe('1.7');
        expect(formatHours(90)).toBe('1.5');
    });

    it('坏值不炸', () => {
        expect(formatHours(NaN)).toBe('0');
    });
});
