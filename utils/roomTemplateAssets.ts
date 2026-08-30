/**
 * Portable references for static assets that ship with the built-in room templates.
 *
 * A built-in template is fetched from `public/room-templates`, but its furniture used
 * to be expanded to the current deployment's absolute URL before it was persisted on
 * the character. That URL breaks after a backup is restored on another origin (or
 * between a root deployment, GitHub Pages sub-path, and the desktop shell).
 *
 * Keep the persisted value deployment-agnostic and resolve it only at render time.
 */

export const BUILTIN_ROOM_ASSET_PREFIX = 'builtin-room-asset://';

const BUILTIN_ROOM_TEMPLATE_IDS = new Set([
    'forest-cottage',
    'blue-minimal',
]);

const ROOM_TEMPLATES_MARKER = '/room-templates/';

type RoomTemplateAssetResolveOptions = {
    baseUrl?: string;
    pageHref?: string;
};

function cleanPath(path: string): string | null {
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized) return null;
    const segments = normalized.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
    return segments.join('/');
}

function makeBuiltinRoomAssetRef(templateId: string, assetPath: string): string | null {
    if (!BUILTIN_ROOM_TEMPLATE_IDS.has(templateId)) return null;
    const clean = cleanPath(assetPath);
    return clean ? `${BUILTIN_ROOM_ASSET_PREFIX}${templateId}/${clean}` : null;
}

function parseBuiltinRoomAssetRef(value: string): { templateId: string; assetPath: string } | null {
    if (!value.startsWith(BUILTIN_ROOM_ASSET_PREFIX)) return null;
    const rest = value.slice(BUILTIN_ROOM_ASSET_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const templateId = rest.slice(0, slash);
    const assetPath = cleanPath(rest.slice(slash + 1));
    if (!BUILTIN_ROOM_TEMPLATE_IDS.has(templateId) || !assetPath) return null;
    return { templateId, assetPath };
}

/**
 * Recognize absolute/root-relative URLs written by older builds and turn them into a
 * portable reference. The origin and any deployment prefix before `/room-templates/`
 * are intentionally discarded.
 */
function portableRefFromLegacyUrl(value: string): string | null {
    let pathname = value;
    try {
        if (/^[a-z][a-z\d+.-]*:/i.test(value)) pathname = new URL(value).pathname;
    } catch {
        return null;
    }

    const markerAt = pathname.lastIndexOf(ROOM_TEMPLATES_MARKER);
    if (markerAt < 0) return null;
    const tail = pathname.slice(markerAt + ROOM_TEMPLATES_MARKER.length);
    const slash = tail.indexOf('/');
    if (slash <= 0) return null;
    return makeBuiltinRoomAssetRef(tail.slice(0, slash), tail.slice(slash + 1));
}

/**
 * Convert a room asset to its storage/backup representation.
 *
 * `templateId` is supplied while reading a built-in template so its local
 * `assets/foo.png` paths can be made portable. Existing absolute URLs from older
 * builds are recognized without it, allowing old backups to heal as well.
 */
export function toPortableBuiltinRoomAsset(value: unknown, templateId?: string): unknown {
    if (typeof value !== 'string' || !value) return value;

    const parsed = parseBuiltinRoomAssetRef(value);
    if (parsed) return makeBuiltinRoomAssetRef(parsed.templateId, parsed.assetPath) || value;

    const legacy = portableRefFromLegacyUrl(value);
    if (legacy) return legacy;

    if (templateId && /^(?:\.\/)?assets\//i.test(value)) {
        return makeBuiltinRoomAssetRef(templateId, value.replace(/^\.\//, '')) || value;
    }

    return value;
}

/** Resolve a portable (or legacy absolute) built-in room asset for this deployment. */
export function resolveBuiltinRoomAssetUrl(
    value: string | undefined | null,
    options: RoomTemplateAssetResolveOptions = {},
): string | undefined {
    if (!value) return value ?? undefined;
    const portable = toPortableBuiltinRoomAsset(value);
    if (typeof portable !== 'string') return value;
    const parsed = parseBuiltinRoomAssetRef(portable);
    if (!parsed) return value;

    const pageHref = options.pageHref
        ?? (typeof window !== 'undefined' ? window.location.href : 'http://localhost/');
    const baseUrl = options.baseUrl ?? ((import.meta as any).env?.BASE_URL || '/');
    try {
        const appBase = new URL(baseUrl, pageHref);
        return new URL(`room-templates/${parsed.templateId}/${parsed.assetPath}`, appBase).href;
    } catch {
        return value;
    }
}

/** Normalize the wall, floor, and furniture references of a fetched room template. */
export function normalizeBuiltInRoomTemplateAssetsInPlace(template: any, templateId: string): void {
    if (!template || typeof template !== 'object') return;
    if (template.room && typeof template.room === 'object') {
        template.room.wallImage = toPortableBuiltinRoomAsset(template.room.wallImage, templateId);
        template.room.floorImage = toPortableBuiltinRoomAsset(template.room.floorImage, templateId);
    }
    if (Array.isArray(template.items)) {
        for (const item of template.items) {
            if (item && typeof item === 'object') {
                item.image = toPortableBuiltinRoomAsset(item.image, templateId);
            }
        }
    }
}

/** Normalize legacy built-in URLs on a character clone before backup serialization. */
export function normalizeCharacterRoomAssetsInPlace(character: any): void {
    const room = character?.roomConfig;
    if (!room || typeof room !== 'object') return;
    room.wallImage = toPortableBuiltinRoomAsset(room.wallImage);
    room.floorImage = toPortableBuiltinRoomAsset(room.floorImage);
    if (Array.isArray(room.items)) {
        for (const item of room.items) {
            if (item && typeof item === 'object') item.image = toPortableBuiltinRoomAsset(item.image);
        }
    }
}
