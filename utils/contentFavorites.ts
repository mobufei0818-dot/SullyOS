import type { GalleryImage, Message } from '../types';
import { DB } from './db';

export const CONTENT_FAVORITES_INDEX_ASSET_ID = 'content_favorites_index_v1';
export const CONTENT_FAVORITES_CHANGED_EVENT = 'sully:content-favorites-changed';

export type ContentFavoriteReference =
    | { source: 'chat'; charId: string; messageId: number }
    | { source: 'gallery'; charId: string; galleryImageId: string }
    | { source: 'favorite_asset'; assetId: string };

export interface ChatFavoriteSnapshot {
    role: Message['role'];
    type: Message['type'];
    content: string;
    timestamp: number;
    replyTo?: Message['replyTo'];
}

interface ContentFavoriteBase {
    id: string;
    charId: string;
    charName: string;
    sourceTimestamp: number;
    favoritedAt: number;
}

export interface ChatContentFavorite extends ContentFavoriteBase {
    kind: 'chat';
    messageId: number;
    /** 文字/卡片的轻量收藏副本；不包含 metadata，更不用于图片消息。 */
    snapshot?: ChatFavoriteSnapshot;
}

export interface ImageContentFavorite extends ContentFavoriteBase {
    kind: 'image';
    /** 仅保存不可逆短指纹用于去重，不保存 URL、Base64、Blob 或图片副本。 */
    fingerprint: string;
    references: ContentFavoriteReference[];
}

export type ContentFavorite = ChatContentFavorite | ImageContentFavorite;

export type ResolvedContentFavorite =
    | { favorite: ChatContentFavorite; message: Message | null; sourceAvailable: boolean }
    | { favorite: ImageContentFavorite; imageUrl: string | null; reference: ContentFavoriteReference | null };

interface ContentFavoritesIndex {
    version: 1;
    items: ContentFavorite[];
}

let writeQueue: Promise<unknown> = Promise.resolve();

const withWriteLock = async <T>(work: () => Promise<T>): Promise<T> => {
    const next = writeQueue.then(work, work);
    writeQueue = next.catch(() => undefined);
    return next;
};

const normalizeTimestamp = (value: unknown, fallback: number): number => (
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
);

const compactHash = (input: string): string => {
    let a = 0x811c9dc5;
    let b = 0x9e3779b9;
    for (let index = 0; index < input.length; index++) {
        const code = input.charCodeAt(index);
        a = Math.imul(a ^ code, 0x01000193);
        b = Math.imul(b ^ code, 0x85ebca6b);
    }
    return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
};

const referenceKey = (reference: ContentFavoriteReference): string => (
    reference.source === 'chat'
        ? `chat:${reference.charId}:${reference.messageId}`
        : reference.source === 'gallery'
            ? `gallery:${reference.charId}:${reference.galleryImageId}`
            : `favorite_asset:${reference.assetId}`
);

const sanitizeReference = (value: unknown): ContentFavoriteReference | null => {
    if (!value || typeof value !== 'object') return null;
    const reference = value as Partial<ContentFavoriteReference> & Record<string, unknown>;
    if (reference.source === 'chat'
        && typeof reference.charId === 'string'
        && typeof reference.messageId === 'number'
        && Number.isSafeInteger(reference.messageId)) {
        return { source: 'chat', charId: reference.charId, messageId: reference.messageId };
    }
    if (reference.source === 'gallery'
        && typeof reference.charId === 'string'
        && typeof reference.galleryImageId === 'string'
        && reference.galleryImageId) {
        return { source: 'gallery', charId: reference.charId, galleryImageId: reference.galleryImageId };
    }
    if (reference.source === 'favorite_asset'
        && typeof reference.assetId === 'string'
        && reference.assetId) {
        return { source: 'favorite_asset', assetId: reference.assetId };
    }
    return null;
};

const sanitizeSnapshot = (value: unknown): ChatFavoriteSnapshot | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const snapshot = value as Partial<ChatFavoriteSnapshot>;
    if (snapshot.role !== 'user' && snapshot.role !== 'assistant' && snapshot.role !== 'system') return undefined;
    if (typeof snapshot.type !== 'string' || typeof snapshot.content !== 'string') return undefined;
    return {
        role: snapshot.role,
        type: snapshot.type as Message['type'],
        content: snapshot.content,
        timestamp: normalizeTimestamp(snapshot.timestamp, Date.now()),
        replyTo: snapshot.replyTo && typeof snapshot.replyTo === 'object' ? snapshot.replyTo : undefined,
    };
};

const sanitizeFavorite = (value: unknown): ContentFavorite | null => {
    if (!value || typeof value !== 'object') return null;
    const item = value as Partial<ContentFavorite> & Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id) return null;
    if (typeof item.charId !== 'string' || typeof item.charName !== 'string') return null;
    const now = Date.now();
    const base = {
        id: item.id,
        charId: item.charId,
        charName: item.charName || '未知角色',
        sourceTimestamp: normalizeTimestamp(item.sourceTimestamp, now),
        favoritedAt: normalizeTimestamp(item.favoritedAt, now),
    };
    if (item.kind === 'chat' && typeof item.messageId === 'number' && Number.isSafeInteger(item.messageId)) {
        return { ...base, kind: 'chat', messageId: item.messageId, snapshot: sanitizeSnapshot(item.snapshot) };
    }
    if (item.kind === 'image' && typeof item.fingerprint === 'string') {
        const seen = new Set<string>();
        const references = (Array.isArray(item.references) ? item.references : [])
            .map(sanitizeReference)
            .filter((reference): reference is ContentFavoriteReference => {
                if (!reference) return false;
                const key = referenceKey(reference);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        if (!references.length) return null;
        return { ...base, kind: 'image', fingerprint: item.fingerprint, references };
    }
    return null;
};

const loadIndex = async (): Promise<ContentFavorite[]> => {
    const raw = await DB.getAssetRaw(CONTENT_FAVORITES_INDEX_ASSET_ID).catch(() => null) as Partial<ContentFavoritesIndex> | ContentFavorite[] | null;
    const items = Array.isArray(raw) ? raw : raw?.items;
    if (!Array.isArray(items)) return [];
    return items.map(sanitizeFavorite).filter((item): item is ContentFavorite => !!item);
};

const saveIndex = async (items: ContentFavorite[]): Promise<void> => {
    await DB.saveAssetRaw(CONTENT_FAVORITES_INDEX_ASSET_ID, { version: 1, items } satisfies ContentFavoritesIndex);
};

const notifyChanged = () => {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CONTENT_FAVORITES_CHANGED_EVENT));
};

export const makeChatContentFavoriteId = (charId: string, messageId: number): string => (
    `chat_${compactHash(`${charId}\u0000${messageId}`)}`
);

export const imageFingerprint = (imageUrl: string): string => compactHash(imageUrl.trim());

export const makeImageContentFavoriteId = (imageUrl: string): string => `image_${imageFingerprint(imageUrl)}`;

export const favoriteImageAssetId = (fingerprint: string): string => `content_favorite_image_${fingerprint}`;

export const contentFavoriteIdForMessage = (message: Pick<Message, 'id' | 'charId' | 'type' | 'content'>): string => (
    message.type === 'image'
        ? makeImageContentFavoriteId(message.content)
        : makeChatContentFavoriteId(message.charId, message.id)
);

export const sortContentFavorites = (items: ContentFavorite[]): ContentFavorite[] => (
    [...items].sort((a, b) => b.sourceTimestamp - a.sourceTimestamp || b.favoritedAt - a.favoritedAt || b.id.localeCompare(a.id))
);

/** Lists compact favorites metadata; chat snapshots are small, while image bodies stay outside the index. */
export const listContentFavorites = async (): Promise<ContentFavorite[]> => sortContentFavorites(await loadIndex());

export const getContentFavoriteById = async (id: string): Promise<ContentFavorite | null> => (
    (await loadIndex()).find(item => item.id === id) || null
);

export const saveMessageContentFavorite = async (
    message: Message,
    charName: string,
): Promise<ContentFavorite> => withWriteLock(async () => {
    const now = Date.now();
    const current = await loadIndex();
    const id = contentFavoriteIdForMessage(message);
    const existing = current.find(item => item.id === id);

    let favorite: ContentFavorite;
    let obsoleteImageAssetIds: string[] = [];
    if (message.type === 'image') {
        const reference: ContentFavoriteReference = { source: 'chat', charId: message.charId, messageId: message.id };
        const linkedGalleryImage = await DB.findGalleryImageBySourceMessageId(message.charId, message.id).catch(() => null)
            || await DB.findGalleryImageByUrl(message.charId, message.content).catch(() => null);
        const existingReferences = existing?.kind === 'image' ? existing.references : [];
        obsoleteImageAssetIds = existingReferences
            .filter((candidate): candidate is Extract<ContentFavoriteReference, { source: 'favorite_asset' }> => candidate.source === 'favorite_asset')
            .map(candidate => candidate.assetId);
        const previousReferences = existingReferences.filter(candidate => candidate.source !== 'favorite_asset');
        const references = [
            ...previousReferences,
            reference,
            ...(linkedGalleryImage
                ? [{ source: 'gallery' as const, charId: linkedGalleryImage.charId, galleryImageId: linkedGalleryImage.id }]
                : []),
        ].filter((candidate, index, all) => (
            all.findIndex(other => referenceKey(other) === referenceKey(candidate)) === index
        ));
        favorite = {
            id,
            kind: 'image',
            fingerprint: imageFingerprint(message.content),
            references,
            charId: message.charId,
            charName: charName || '未知角色',
            sourceTimestamp: normalizeTimestamp(message.timestamp, now),
            favoritedAt: existing?.favoritedAt || now,
        };
    } else {
        favorite = {
            id,
            kind: 'chat',
            messageId: message.id,
            charId: message.charId,
            charName: charName || '未知角色',
            sourceTimestamp: normalizeTimestamp(message.timestamp, now),
            favoritedAt: existing?.favoritedAt || now,
            snapshot: {
                role: message.role,
                type: message.type,
                content: message.content,
                timestamp: message.timestamp,
                replyTo: message.replyTo,
            },
        };
    }

    await saveIndex([favorite, ...current.filter(item => item.id !== id)]);
    await Promise.all(obsoleteImageAssetIds.map(assetId => DB.deleteAsset(assetId).catch(() => undefined)));
    notifyChanged();
    return favorite;
});

export const saveGalleryImageContentFavorite = async (
    image: GalleryImage,
    charName: string,
): Promise<ImageContentFavorite> => withWriteLock(async () => {
    const now = Date.now();
    const current = await loadIndex();
    const id = makeImageContentFavoriteId(image.url);
    const existing = current.find(item => item.id === id);
    const existingReferences = existing?.kind === 'image' ? existing.references : [];
    const obsoleteImageAssetIds = existingReferences
        .filter((candidate): candidate is Extract<ContentFavoriteReference, { source: 'favorite_asset' }> => candidate.source === 'favorite_asset')
        .map(candidate => candidate.assetId);
    const linkedMessage = typeof image.sourceMessageId === 'number'
        ? await DB.getMessageById(image.sourceMessageId).catch(() => null)
        : await DB.findImageMessageByUrl(image.charId, image.url).catch(() => null);
    const referenceCandidates: ContentFavoriteReference[] = [
        ...existingReferences.filter(candidate => candidate.source !== 'favorite_asset'),
        { source: 'gallery' as const, charId: image.charId, galleryImageId: image.id },
        ...(linkedMessage?.charId === image.charId && linkedMessage.type === 'image' && linkedMessage.content === image.url
            ? [{ source: 'chat' as const, charId: image.charId, messageId: linkedMessage.id }]
            : []),
    ];
    const references = referenceCandidates.filter((candidate, index, all) => (
        all.findIndex(other => referenceKey(other) === referenceKey(candidate)) === index
    ));
    const favorite: ImageContentFavorite = {
        id,
        kind: 'image',
        fingerprint: imageFingerprint(image.url),
        references,
        charId: image.charId,
        charName: charName || '未知角色',
        sourceTimestamp: normalizeTimestamp(image.timestamp, now),
        favoritedAt: existing?.favoritedAt || now,
    };
    await saveIndex([favorite, ...current.filter(item => item.id !== id)]);
    await Promise.all(obsoleteImageAssetIds.map(assetId => DB.deleteAsset(assetId).catch(() => undefined)));
    notifyChanged();
    return favorite;
});

export const removeContentFavoriteById = async (id: string): Promise<boolean> => withWriteLock(async () => {
    const current = await loadIndex();
    const existing = current.find(item => item.id === id);
    if (!existing) return false;
    await saveIndex(current.filter(item => item.id !== id));
    if (existing.kind === 'image') {
        await Promise.all(existing.references
            .filter((reference): reference is Extract<ContentFavoriteReference, { source: 'favorite_asset' }> => reference.source === 'favorite_asset')
            .map(reference => DB.deleteAsset(reference.assetId).catch(() => undefined)));
    }
    notifyChanged();
    return true;
});

interface FavoriteImageAsset {
    version: 1;
    imageUrl: string;
    savedAt: number;
}

const resolveImageReference = async (reference: ContentFavoriteReference): Promise<string | null> => {
    if (reference.source === 'favorite_asset') {
        const raw = await DB.getAssetRaw(reference.assetId).catch(() => null) as Partial<FavoriteImageAsset> | string | null;
        if (typeof raw === 'string') return raw;
        return typeof raw?.imageUrl === 'string' && raw.imageUrl ? raw.imageUrl : null;
    }
    if (reference.source === 'gallery') {
        const image = await DB.getGalleryImageById(reference.galleryImageId).catch(() => null);
        return image?.charId === reference.charId ? image.url : null;
    }
    const message = await DB.getMessageById(reference.messageId).catch(() => null);
    return message?.charId === reference.charId && message.type === 'image' ? message.content : null;
};

type DeletionIntent<T> = { ids?: T[]; charId?: string };

const referenceMatchesDeletion = (
    reference: ContentFavoriteReference,
    source: 'chat' | 'gallery',
    intent: DeletionIntent<number | string>,
): boolean => {
    if (reference.source !== source) return false;
    if (intent.charId && reference.charId === intent.charId) return true;
    if (!intent.ids?.length) return false;
    return reference.source === 'chat'
        ? intent.ids.includes(reference.messageId)
        : intent.ids.includes(reference.galleryImageId);
};

const preserveImageFavoritesBeforeDeletion = async (
    source: 'chat' | 'gallery',
    intent: DeletionIntent<number | string>,
): Promise<void> => withWriteLock(async () => {
    const current = await loadIndex();
    let changed = false;
    const nextItems: ContentFavorite[] = [];

    for (const item of current) {
        if (item.kind !== 'image') {
            nextItems.push(item);
            continue;
        }
        const affected = item.references.filter(reference => referenceMatchesDeletion(reference, source, intent));
        if (!affected.length) {
            nextItems.push(item);
            continue;
        }

        const candidates = item.references.filter(reference => !referenceMatchesDeletion(reference, source, intent));
        const surviving: ContentFavoriteReference[] = [];
        for (const reference of candidates) {
            const url = await resolveImageReference(reference);
            if (url && makeImageContentFavoriteId(url) === item.id) surviving.push(reference);
        }

        if (!surviving.length) {
            let imageUrl: string | null = null;
            for (const reference of affected) {
                imageUrl = await resolveImageReference(reference);
                if (imageUrl) break;
            }
            if (!imageUrl) throw new Error('无法保留已收藏图片，已取消删除原图');
            const assetId = favoriteImageAssetId(item.fingerprint);
            await DB.saveAssetRaw(assetId, {
                version: 1,
                imageUrl,
                savedAt: Date.now(),
            } satisfies FavoriteImageAsset);
            surviving.push({ source: 'favorite_asset', assetId });
        }

        changed = true;
        nextItems.push({ ...item, references: surviving });
    }

    if (changed) {
        await saveIndex(nextItems);
        notifyChanged();
    }
});

/** Called by DB deletion paths before removing original chat rows. */
export const preserveContentFavoritesBeforeMessageDeletion = async (
    intent: { ids?: number[]; charId?: string },
): Promise<void> => preserveImageFavoritesBeforeDeletion('chat', intent);

/** Called by DB deletion paths before removing original gallery rows. */
export const preserveContentFavoritesBeforeGalleryDeletion = async (
    intent: { ids?: string[]; charId?: string },
): Promise<void> => preserveImageFavoritesBeforeDeletion('gallery', intent);

export const resolveContentFavorite = async (favorite: ContentFavorite): Promise<ResolvedContentFavorite> => {
    if (favorite.kind === 'chat') {
        const message = await DB.getMessageById(favorite.messageId).catch(() => null);
        const sourceMessage = message?.charId === favorite.charId ? message : null;
        const snapshotMessage: Message | null = favorite.snapshot ? {
            id: favorite.messageId,
            charId: favorite.charId,
            role: favorite.snapshot.role,
            type: favorite.snapshot.type,
            content: favorite.snapshot.content,
            timestamp: favorite.snapshot.timestamp,
            replyTo: favorite.snapshot.replyTo,
        } : null;
        return {
            favorite,
            message: sourceMessage || snapshotMessage,
            sourceAvailable: !!sourceMessage,
        };
    }

    // Prefer a live gallery/chat reference. A favorite-owned asset appears only after
    // the last live source was deleted, and is then the sole retained media owner.
    const references = [...favorite.references].sort((a, b) => (
        Number(b.source === 'gallery') - Number(a.source === 'gallery')
    ));
    for (const reference of references) {
        const imageUrl = await resolveImageReference(reference);
        if (imageUrl && makeImageContentFavoriteId(imageUrl) === favorite.id) {
            return { favorite, imageUrl, reference };
        }
    }
    return { favorite, imageUrl: null, reference: null };
};
