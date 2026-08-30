export type CollaborationMode = 'immersive' | 'focused';

export type CollaborationUiTheme = 'sully' | 'gpt' | 'claude' | 'gemini' | 'kimi' | 'deepseek';

/** Avatar visibility is independent from the workspace skin. */
export type CollaborationAvatarMode = 'theme' | 'both' | 'character' | 'user' | 'none';

export type CollaborationAvatarStyle = 'circle' | 'rounded' | 'portrait';

export type CollaborationMessageRole = 'user' | 'assistant' | 'system';

export type CollaborationAttachmentKind = 'source' | 'artifact' | 'installable';

export type CollaborationMakerKind =
  | 'bubble-theme'
  | 'whitebox-css'
  | 'appearance-preset'
  | 'journal-css'
  | 'schedule-css'
  | 'psyche-css'
  | 'character-card'
  | 'worldbook';

export type CollaborationArtifactFormat = 'txt' | 'md' | 'html' | 'json' | 'docx' | 'pdf';

export interface CollaborationAttachment {
  id: string;
  assetId: string;
  kind: CollaborationAttachmentKind;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
  extractedText?: string;
  pageCount?: number;
  format?: CollaborationArtifactFormat;
  installableKind?: CollaborationMakerKind;
}

/**
 * A lightweight view over an attachment that already lives in a collaboration
 * message. It deliberately carries no Blob: ChatApp messages only keep the
 * assetId and always reopen the one canonical asset from this library.
 */
export interface CollaborationLibraryFile extends CollaborationAttachment {
  sessionId: string;
  sessionTitle: string;
  messageId: string;
}

export interface CollaborationMessage {
  id: string;
  sessionId: string;
  role: CollaborationMessageRole;
  content: string;
  /** Native reasoning_content / inline <think>, kept separate from the deliverable. */
  thinkingChain?: string;
  createdAt: number;
  attachments?: CollaborationAttachment[];
}

/**
 * Frozen ChatApp context carried by an immersive collaboration window.
 * Keeping the original roles is important: flattening recent chat into one
 * system paragraph changes who said what and behaves noticeably worse.
 */
export interface CollaborationContextMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CollaborationSession {
  id: string;
  charId: string;
  title: string;
  mode: CollaborationMode;
  categoryId?: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  lastMessagePreview?: string;
  /**
   * A session freezes its character/world context on the first user turn. The
   * task-related Memory Palace block is intentionally rebuilt on every send.
   */
  contextSnapshot?: string;
  /**
   * 沉浸式协同首次发言时冻结的 ChatApp 角色上下文与最近聊天。
   * 动态记忆不保存在这里；它逐轮召回，因此窗口之间不会互通。
   */
  chatContextSnapshot?: CollaborationContextMessage[];
  /** 当前窗口选择的制作类型；只向这个窗口注入对应制作规范。 */
  makerKind?: CollaborationMakerKind;
  /** 只有用户在归档确认中选“写入记忆”后才存在，用于防止重复总结。 */
  memoryArchivedAt?: number;
  memoryArchiveSummary?: string;
}

export interface CollaborationInstallableArtifact {
  kind: CollaborationMakerKind;
  title: string;
  payload: Record<string, unknown>;
}

export interface CollaborationCategory {
  id: string;
  name: string;
  createdAt: number;
}

export interface CollaborationApiProfile {
  baseUrl: string;
  apiKey: string;
  model: string;
  stream: boolean;
  temperature: number;
  /**
   * `chat` / `preset` keep the credentials discoverable from the shared API
   * library. `custom` is an intentionally detached collaboration-only copy.
   */
  source?: 'chat' | 'preset' | 'custom';
  sourceId?: string;
  sourceName?: string;
}

export interface CollaborationSettings {
  id: 'main';
  /** Optional for backups created before collaboration skins existed. */
  uiTheme?: CollaborationUiTheme;
  /** `theme` follows each skin's layout; every other value is an explicit user override. */
  avatarMode?: CollaborationAvatarMode;
  avatarStyle?: CollaborationAvatarStyle;
  immersive: CollaborationApiProfile;
  focused: CollaborationApiProfile;
  updatedAt: number;
}

export interface CollaborationAssetRecord {
  id: string;
  blob: Blob;
  createdAt: number;
}

/** Binary file entry stored outside backup JSON in collaboration/assets/. */
export interface CollaborationBackupAssetIndexEntry {
  id: string;
  path: string;
  mimeType: string;
  size: number;
  createdAt: number;
}

export interface CollaborationBackupSnapshot {
  sessions?: CollaborationSession[];
  messages?: CollaborationMessage[];
  categories?: CollaborationCategory[];
  settings?: CollaborationSettings;
  assets?: CollaborationAssetRecord[];
}

export interface CollaborationTransferMessage {
  role: 'user' | 'assistant';
  type: 'text';
  content: string;
  timestamp: number;
}

export const EMPTY_COLLABORATION_API_PROFILE: CollaborationApiProfile = {
  baseUrl: '',
  apiKey: '',
  model: '',
  stream: true,
  temperature: 0.7,
};

export const DEFAULT_COLLABORATION_SETTINGS: CollaborationSettings = {
  id: 'main',
  uiTheme: 'sully',
  avatarMode: 'theme',
  avatarStyle: 'circle',
  immersive: { ...EMPTY_COLLABORATION_API_PROFILE },
  focused: { ...EMPTY_COLLABORATION_API_PROFILE },
  updatedAt: 0,
};

export const collaborationId = (prefix: string): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};
