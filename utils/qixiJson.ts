const COMMON_WRAPPERS = ['data', 'result', 'output', 'payload'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const stripCodeFences = (raw: string): string => raw
    .replace(/^\uFEFF/, '')
    .replace(/```(?:json|jsonc|javascript|js)?/gi, '')
    .replace(/```/g, '')
    .trim();

/**
 * Normalize only syntax outside JSON strings. Content stays untouched while
 * common LLM formatting drift (smart/single delimiters, full-width separators,
 * comments and literal newlines) is repaired.
 */
function normalizeLooseSyntax(input: string): string {
    let output = '';
    let quote: 'double' | 'single' | 'smart' | null = null;
    let escaped = false;

    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        const next = input[index + 1];

        if (quote) {
            if (escaped) {
                output += char;
                escaped = false;
                continue;
            }
            if (char === '\\') {
                output += char;
                escaped = true;
                continue;
            }
            const closesDouble = quote === 'double' && char === '"';
            const closesSingle = quote === 'single' && char === "'";
            const closesSmart = quote === 'smart' && char === '”';
            if (closesDouble || closesSingle || closesSmart) {
                if (quote !== 'double') {
                    const remaining = input.slice(index + 1);
                    const nextToken = remaining.match(/^\s*([,:}\]，：；｝］])/)?.[1];
                    if (!nextToken && remaining.trim()) {
                        output += char;
                        continue;
                    }
                }
                output += '"';
                quote = null;
                continue;
            }
            if (quote !== 'double' && char === '"') {
                output += '\\"';
                continue;
            }
            if (char === '\n' || char === '\r') {
                output += '\\n';
                if (char === '\r' && next === '\n') index += 1;
                continue;
            }
            if (char === '\t') {
                output += '\\t';
                continue;
            }
            output += char;
            continue;
        }

        if (char === '/' && next === '/') {
            while (index < input.length && input[index] !== '\n') index += 1;
            output += '\n';
            continue;
        }
        if (char === '/' && next === '*') {
            index += 2;
            while (index < input.length - 1 && !(input[index] === '*' && input[index + 1] === '/')) index += 1;
            index += 1;
            continue;
        }
        if (char === '"') {
            quote = 'double';
            output += char;
            continue;
        }
        if (char === "'") {
            quote = 'single';
            output += '"';
            continue;
        }
        if (char === '“' || char === '”') {
            quote = 'smart';
            output += '"';
            continue;
        }
        if (char === '：') output += ':';
        else if (char === '，' || char === '；') output += ',';
        else output += char;
    }

    if (quote) output += '"';
    return output;
}

function quoteBareKeys(input: string): string {
    let output = '';
    let inString = false;
    let escaped = false;

    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        if (inString) {
            output += char;
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            output += char;
            continue;
        }
        output += char;
        if (char !== '{' && char !== ',') continue;

        let cursor = index + 1;
        let whitespace = '';
        while (/\s/.test(input[cursor] || '')) whitespace += input[cursor++];
        const key = input.slice(cursor).match(/^[A-Za-z_$][\w$-]*/)?.[0];
        if (!key) continue;
        let afterKey = cursor + key.length;
        let keyWhitespace = '';
        while (/\s/.test(input[afterKey] || '')) keyWhitespace += input[afterKey++];
        if (input[afterKey] !== ':') continue;
        output += `${whitespace}"${key}"${keyWhitespace}`;
        index = afterKey - 1;
    }
    return output;
}

function removeTrailingCommas(input: string): string {
    let output = '';
    let inString = false;
    let escaped = false;
    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        if (inString) {
            output += char;
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            output += char;
            continue;
        }
        if (char === ',') {
            let cursor = index + 1;
            while (/\s/.test(input[cursor] || '')) cursor += 1;
            if (input[cursor] === '}' || input[cursor] === ']') continue;
        }
        output += char;
    }
    return output;
}

function completeOpenContainers(input: string): string {
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (const char of input) {
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') stack.push('}');
        else if (char === '[') stack.push(']');
        else if ((char === '}' || char === ']') && stack.at(-1) === char) stack.pop();
    }
    return input + stack.reverse().join('');
}

function candidateFrom(input: string, start: number): string {
    const stack: string[] = [];
    let quote: 'double' | 'single' | 'smart' | null = null;
    let escaped = false;
    for (let index = start; index < input.length; index += 1) {
        const char = input[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (quote === 'double' && char === '"') quote = null;
            else if (quote === 'single' && char === "'") quote = null;
            else if (quote === 'smart' && char === '”') quote = null;
            continue;
        }
        if (char === '"') quote = 'double';
        else if (char === "'") quote = 'single';
        else if (char === '“' || char === '”') quote = 'smart';
        else if (char === '{') stack.push('}');
        else if (char === '[') stack.push(']');
        else if ((char === '}' || char === ']') && stack.at(-1) === char) {
            stack.pop();
            if (!stack.length) return input.slice(start, index + 1);
        }
    }
    return input.slice(start);
}

function repairCandidate(candidate: string): string {
    const normalized = normalizeLooseSyntax(candidate)
        .replace(/｛/g, '{')
        .replace(/｝/g, '}')
        .replace(/［/g, '[')
        .replace(/］/g, ']');
    return completeOpenContainers(removeTrailingCommas(quoteBareKeys(normalized)));
}

/**
 * Parse Qixi model output with light syntax recovery. Schema/provenance checks
 * remain the responsibility of each Part parser and are intentionally strict.
 */
export function parseQixiJsonObject(raw: string, expectedKeys: string[] = []): Record<string, unknown> | null {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const stripped = stripCodeFences(raw).replace(/｛/g, '{').replace(/｝/g, '}');
    const starts = [...stripped.matchAll(/\{/g)].map(match => match.index || 0).slice(0, 32);
    const parsedCandidates: Array<{ value: Record<string, unknown>; size: number }> = [];

    for (const start of starts) {
        const candidate = candidateFrom(stripped, start);
        for (const source of [candidate, repairCandidate(candidate)]) {
            try {
                const value = JSON.parse(source);
                if (isRecord(value)) parsedCandidates.push({ value, size: source.length });
            } catch { /* try the repaired or next balanced object */ }
        }
    }
    parsedCandidates.sort((left, right) => right.size - left.size);
    for (const candidate of parsedCandidates) {
        if (!expectedKeys.length || expectedKeys.some(key => key in candidate.value)) return candidate.value;
        for (const wrapper of COMMON_WRAPPERS) {
            const nested = candidate.value[wrapper];
            if (isRecord(nested) && expectedKeys.some(key => key in nested)) return nested;
        }
    }
    return parsedCandidates[0]?.value || null;
}
