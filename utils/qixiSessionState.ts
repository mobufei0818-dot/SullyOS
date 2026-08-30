export type QixiEntryAttitude = 'explore' | 'shout' | 'stay';

export interface QixiWordArtifactLike {
    id: string;
    label: string;
    kind?: string;
    evidenceIds?: string[];
}

/**
 * Enter the playable rooms without replacing the rest of the session. Part 2
 * and Part 3 may already have finished in the background, so their results must
 * survive this transition.
 */
export function enterQixiInterlayerState<T extends { stage: string }>(
    current: T,
    attitude: QixiEntryAttitude,
): T & { stage: 'scene'; attitude: QixiEntryAttitude } {
    return { ...current, stage: 'scene', attitude };
}

/**
 * The grape-arbor words are a turn exchange, not a multi-select form. A User
 * word is accepted only after the Char side has answered the previous pick.
 */
export function selectQixiWordTurn(
    selected: string[],
    charRevealed: number,
    artifactId: string,
    max = 3,
): string[] {
    // Old/incomplete mobile saves can contain a reveal counter ahead of the
    // actual User selections. Treat only the matching portion as revealed so
    // the next tap repairs the session instead of becoming a no-op forever.
    const effectiveCharRevealed = Math.min(charRevealed, selected.length);
    if (selected.length >= max || selected.length !== effectiveCharRevealed || selected.includes(artifactId)) return selected;
    return [...selected, artifactId];
}

const normalizeWordKey = (value: string): string => value.trim().toLocaleLowerCase();
const looksLikeBareArtifactId = (value: string): boolean => {
    const trimmed = value.trim();
    return /^(?:a|artifact|trait|word)[_-]?\d+$/i.test(trimmed)
        || /^[a-z]+[-_][a-z0-9_-]*\d+$/i.test(trimmed);
};

/**
 * Models commonly return the word cloud as artifact ids, artifact labels, or
 * inline option labels. Preserve all of those generated forms. The old UI only
 * accepted exact ids from the first generation phase, which could leave room
 * 07 with a visible 0/3 counter and no buttons at all.
 */
export function resolveQixiWordArtifacts(
    artifactRefs: string[],
    charSelectionRefs: string[],
    artifacts: QixiWordArtifactLike[],
    inlineOptions: QixiWordArtifactLike[] = [],
    max = 20,
): QixiWordArtifactLike[] {
    const result: QixiWordArtifactLike[] = [];
    const usedIds = new Set<string>();
    const usedLabels = new Set<string>();
    const add = (artifact: QixiWordArtifactLike | undefined) => {
        if (!artifact?.label?.trim() || result.length >= max) return;
        const idKey = normalizeWordKey(artifact.id || artifact.label);
        const labelKey = normalizeWordKey(artifact.label);
        if (usedIds.has(idKey) || usedLabels.has(labelKey)) return;
        usedIds.add(idKey);
        usedLabels.add(labelKey);
        result.push({ ...artifact, id: artifact.id || `qixi-word-${result.length + 1}`, label: artifact.label.trim() });
    };
    const resolveRef = (ref: string, index: number) => {
        const key = normalizeWordKey(ref);
        const matched = artifacts.find(item => normalizeWordKey(item.id) === key || normalizeWordKey(item.label) === key)
            || inlineOptions.find(item => normalizeWordKey(item.id) === key || normalizeWordKey(item.label) === key);
        if (matched) return add(matched);
        // A human-readable label is already final LLM prose. Keep it instead of
        // discarding it merely because the model did not repeat a top-level id.
        if (!looksLikeBareArtifactId(ref)) add({ id: `qixi-inline-word-${index + 1}`, label: ref, kind: 'trait', evidenceIds: [] });
    };

    artifactRefs.forEach(resolveRef);
    inlineOptions.forEach(add);
    charSelectionRefs.forEach((ref, index) => resolveRef(ref, artifactRefs.length + index));
    artifacts.filter(item => item.kind === 'trait').forEach(add);
    artifacts.forEach(add);
    return result;
}

export function resolveQixiWordSelectionIds(refs: string[], words: QixiWordArtifactLike[], max = 3): string[] {
    const selected: string[] = [];
    refs.forEach(ref => {
        const key = normalizeWordKey(ref);
        const match = words.find(item => normalizeWordKey(item.id) === key || normalizeWordKey(item.label) === key);
        if (match && !selected.includes(match.id) && selected.length < max) selected.push(match.id);
    });
    return selected;
}

export const qixiWordPickTarget = (available: number, desired = 3): number =>
    Math.max(0, Math.min(desired, Math.floor(available)));
