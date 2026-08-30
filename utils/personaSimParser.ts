import type { SimBeat, SimBeatKind, SimScript } from '../types';
import { extractContent, extractJson } from './safeApi';

const SIM_BEAT_KINDS = new Set<SimBeatKind>([
  'lock',
  'thought',
  'notification',
  'app',
  'flashback',
  'end',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

/** Preserve JSON structure while escaping literal control characters inside strings. */
const escapeJsonStringControls = (value: string): string => {
  let inString = false;
  let escaped = false;
  let output = '';
  for (const char of value) {
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      output += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      output += char;
      continue;
    }
    if (inString && char === '\n') {
      output += '\\n';
      continue;
    }
    if (inString && char === '\r') {
      output += '\\r';
      continue;
    }
    if (inString && char === '\t') {
      output += '\\t';
      continue;
    }
    output += char;
  }
  return output;
};

const findScriptShape = (value: unknown): Record<string, unknown> | null => {
  let current = value;
  for (let depth = 0; depth < 5; depth += 1) {
    if (Array.isArray(current)) return { title: '', summary: '', beats: current };
    if (!isRecord(current)) return null;
    const record = current;
    if (Array.isArray(record.beats)) return record;
    const wrapped = ['script', 'result', 'data', 'output']
      .map(key => record[key])
      .find(item => Array.isArray(item) || isRecord(item));
    if (!wrapped) return null;
    current = wrapped;
  }
  return null;
};

const normalizeBeat = (value: unknown): SimBeat | null => {
  if (!isRecord(value) || typeof value.kind !== 'string' || !SIM_BEAT_KINDS.has(value.kind as SimBeatKind)) {
    return null;
  }
  return { ...value, kind: value.kind as SimBeatKind } as unknown as SimBeat;
};

const normalizeScript = (value: unknown): SimScript | null => {
  const record = findScriptShape(value);
  if (!record || !Array.isArray(record.beats)) return null;
  const beats = record.beats.map(normalizeBeat).filter((beat): beat is SimBeat => Boolean(beat));
  if (!beats.length) return null;
  const buff = isRecord(record.buff) && typeof record.buff.label === 'string'
    ? record.buff as unknown as SimScript['buff']
    : undefined;
  return {
    title: typeof record.title === 'string' ? record.title : '',
    summary: typeof record.summary === 'string' ? record.summary : '',
    ...(typeof record.ending === 'string' ? { ending: record.ending } : {}),
    ...(buff ? { buff } : {}),
    beats,
  };
};

/** Parse the common JSON variants returned by OpenAI-compatible chat models. */
export const parsePersonaScriptResponse = (raw: string): SimScript | null => {
  if (!raw.trim()) return null;
  const controlFixed = escapeJsonStringControls(raw);
  const candidates = controlFixed === raw ? [raw] : [controlFixed, raw];
  for (const candidate of candidates) {
    const normalized = normalizeScript(extractJson(candidate));
    if (normalized) return normalized;
  }
  return null;
};

/** Extract text from thinking/content-array responses before parsing the script. */
export const parsePersonaScriptApiResponse = (data: unknown): {
  content: string;
  script: SimScript | null;
} => {
  const content = extractContent(data);
  return { content, script: parsePersonaScriptResponse(content) };
};
