import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Camera, CaretRight, ChatCircleText, Check, DotsThree, Heart, ImageSquare, LockKey, Plus, Trash, UsersThree, X, PaperPlaneTilt, ArrowsClockwise, UserPlus, Sparkle, GearSix } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { putImageBlob } from '../utils/blobRef';
import { processImageToBlob } from '../utils/file';
import TokenImg from '../components/os/TokenImg';
import type { CharacterProfile, GalleryImage, MemoryFragment, MomentsComment, MomentsEventLedgerEntry, MomentsEventType, MomentsInteractionMode, MomentsMediaRef, MomentsPendingJob, MomentsPost, MomentsPostingMode, MomentsProfile, MomentsReaction, MomentsSettings, MomentsTempStranger, MomentsTempTranscript, MomentsVisibilityMode, MomentsApiConfig, MomentsWorkerConfig, MomentsWorkerDiagnostics } from '../types';
import { generateChatImage, isImageGenerationConfigured } from '../utils/imageGeneration';
import { fetchMomentsModels, isMomentsApiReady, momentsApiFromMain, momentsApiFromPreset, planMomentsCharacterPost, planMomentsInteractions, planMomentsNpcCharacterProfile, planMomentsNpcProfiles, planMomentsStranger, planMomentsStrangerCharacterProfile, replyMomentsStranger, testMomentsApi, type MomentsInteractionActorContext } from '../utils/momentsApi';
import { acknowledgeMomentsDeliveries, claimMomentsTask, completeMomentsTask, getMomentsWorkerDiagnostics, hasPendingMomentsSyncWork, isD1DailyLimitError, isMomentsWorkerReady, outboxToSyncPayload, pullMomentsDeliveries, pullMomentsTasks, syncMomentsOutbox, syncMomentsRuntime, type MomentsCloudActorRuntime } from '../utils/momentsSync';
import { ActiveMsgStore } from '../utils/activeMsgStore';
import { ActiveMsgClient } from '../utils/activeMsgClient';
import { buildMomentsLlmCredentialRow, MOMENTS_LLM_CREDENTIAL_ID } from '../utils/amsgLlmCredentials';
import { mirrorMomentsEventToMemoryPalace, removeMomentsPostFromMemoryPalace, removeMomentsSourcesFromMemoryPalace, repairMomentsMemoryPalaceForCharacter, type MomentsMemoryEventDetail } from '../utils/momentsMemoryPalace';
import { reportRelationshipJealousyEvents, setRelationshipJealousyForceEnabled } from '../utils/relationshipBackend';
import { MemoryNodeDB } from '../utils/memoryPalace/db';
import { buildCollaborationContextSnapshot, selectCollaborationMemories } from '../features/collaboration/context';
import type { MemoryNode } from '../utils/memoryPalace/types';
import { resolveCharTimeZone } from '../utils/timezone';

const USER_PROFILE_ID = 'moments:user';
const DEFAULT_SETTINGS: MomentsSettings = {
  id: 'main', enabled: true, strangersCanViewTen: false,
  autoInteractionEnabled: true, offlineSyncEnabled: false, jealousyForceEnabled: true,
  characterPostingModes: {},
  npcPostingModes: {},
  characterInteractionModes: {},
  visibilityGroups: [],
  momentsApi: undefined,
  worker: undefined,
  syncStatus: 'idle',
  updatedAt: Date.now(),
};

type View = 'feed' | 'profile' | 'messages' | 'settings';
const formatMomentTime = (timestamp: number) => {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
};

const defaultCover = 'linear-gradient(135deg, #5e8da7 0%, #9ab7ba 44%, #e7d3bd 100%)';

const defaultProfile = (name: string, avatar?: string): MomentsProfile => ({
  id: USER_PROFILE_ID,
  actorType: 'user',
  displayName: name || '我',
  avatar,
  cover: defaultCover,
  bio: '',
  updatedAt: Date.now(),
});

const unique = <T,>(items: T[]) => Array.from(new Set(items));
const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char] || char));
const stableHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
};
const normalizedPersonName = (value?: string) => (value || '').normalize('NFKC').replace(/[\s·•・._-]+/g, '').toLocaleLowerCase();
const randomItem = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];
const createLocalRandomStranger = (attractive: boolean, now = new Date()) => {
  const surnames = ['顾', '林', '许', '沈', '周', '江', '温', '陆', '宋', '叶', '程', '唐', '乔', '白', '季', '苏', '谢', '陈', '赵', '罗', '邵', '闻', '余', '夏'];
  const givenA = ['予', '知', '砚', '遥', '弥', '野', '澄', '屿', '眠', '栀', '川', '棠', '禾', '安', '序', '宁', '言', '清', '越', '寻', '照', '临'];
  const givenB = ['', '舟', '遥', '然', '川', '野', '宁', '夏', '秋', '白', '星', '言', '初', '屿', '禾', '安', '清'];
  const jobs = ['做展陈设计', '在医院规培', '经营一家旧书店', '做独立游戏音效', '在出版社做校对', '读城市规划研究生', '做烘焙研发', '跑纪录片后期', '在宠物医院值班', '做舞台灯光', '在社区做社工', '做文物修复', '开长途货车', '做房产中介', '在便利店上夜班', '自由接插画稿', '教少儿击剑', '做实验室技术员'];
  const temperaments = attractive
    ? ['慢热但观察很细', '讲话直接，熟了会很会接梗', '看着冷淡，其实很容易心软', '情绪稳定，但偶尔有点孩子气', '不爱端着，边界感却很清楚']
    : ['有点自来熟，偶尔冒失', '嘴快，常常说完才反应过来', '爱打听但没什么坏心', '有一点臭屁，输了嘴也硬', '社交能量忽高忽低'];
  const hobbies = ['收集旧车票', '下班后去游泳', '会给路边的猫起名字', '最近在学木工', '喜欢凌晨看老电影', '周末逛菜市场', '爱拍奇怪的路牌', '在练一首很难的曲子', '骑车找城市里没走过的路', '喜欢研究便利店新品'];
  const name = `${randomItem(surnames)}${randomItem(givenA)}${Math.random() < 0.58 ? randomItem(givenB) : ''}`;
  const bio = `${randomItem(jobs)}，${randomItem(temperaments)}，${randomItem(hobbies)}。`;
  const hour = now.getHours();
  const openingLine = hour < 6 ? '这么晚还能摇到人。你也是睡不着，还是刚忙完？'
    : hour < 10 ? '早，居然这个点摇到人了。你已经出门了吗？'
      : hour < 14 ? '刚好摸鱼摇了一下，真有人。你午饭解决了吗？'
        : hour < 18 ? '刚从手头的事里喘口气，没想到真摇到人了。'
          : hour < 23 ? '晚上好，刚在回去的路上随手摇了一下。'
            : '这个点还亮着屏幕的人不多了。你还没睡？';
  return { name, bio, openingLine };
};
/** 先由系统落实好友数量规则，再把入选名单一次性交给副 API 写自然互动。 */
const selectInteractionActors = (postId: string, actors: MomentsProfile[]) => {
  const count = actors.length;
  const limit = count <= 3 ? count : count <= 5 ? Math.ceil(count * 0.8) : count <= 10 ? Math.ceil(count * 0.65) : Math.ceil(count * 0.5);
  return [...actors].sort((a, b) => stableHash(`${postId}:${a.id}`) - stableHash(`${postId}:${b.id}`)).slice(0, limit);
};
const isSleepingSlot = (activity?: string) => /睡|休息|午休|熬夜睡/.test(activity || '');
const localDateKey = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const postingOpportunityCount = (mode: MomentsPostingMode) => mode === 'high' ? 3 : mode === 'medium' ? 1 : mode === 'low' ? 1 : 0;
const isLowPostingDay = (characterId: string, dateKey: string) => stableHash(`${characterId}:${dateKey}`) % 7 < 3;

const PASSERBY_NAMES = ['林栀', '周屿', '许眠', '陈默', '沈棠', '顾川', '叶青', '陆遥', '宋弥', '程野', '夏柚', '白榆', '江澄', '唐梨', '温禾', '乔安'];
const PASSERBY_BIOS = [
  '偶尔刷到附近动态的普通上班族，说话简短随和。',
  '喜欢拍街景和食物的路人，评论直白但没有恶意。',
  '作息不太规律的年轻人，只对真正感兴趣的内容开口。',
  '安静的本地生活观察者，通常只点赞，偶尔留一句话。',
  '路过朋友圈的陌生人，性格外向，容易被有趣内容吸引。',
  '审美挑剔但有分寸的路人，不会假装认识动态作者。',
];

/** 每帖稳定地产生 2–5 位完全无关的路人；不进入好友人数分档，也不会沉淀为正式 NPC 档案。 */
const randomPasserbyActorsForPost = (postId: string): MomentsProfile[] => {
  const count = 2 + stableHash(`${postId}:passerby-count`) % 4;
  return Array.from({ length: count }, (_, index) => {
    const seed = stableHash(`${postId}:passerby:${index}`);
    const name = PASSERBY_NAMES[seed % PASSERBY_NAMES.length];
    return {
      id: `moments:passerby:${postId}:${index}:${seed.toString(36)}`,
      actorType: 'npc' as const,
      displayName: name,
      bio: PASSERBY_BIOS[Math.floor(seed / PASSERBY_NAMES.length) % PASSERBY_BIOS.length],
      relationLabel: '随机路人',
      friendshipState: 'temporary' as const,
      updatedAt: Date.now(),
    };
  });
};

const actorNameFromMomentsSnapshot = (
  actorId: string | undefined,
  post: MomentsPost | undefined,
  comments: MomentsComment[],
  reactions: MomentsReaction[],
  profiles: MomentsProfile[],
) => {
  if (!actorId) return '';
  return comments.find(item => item.actorId === actorId)?.actorName
    || reactions.find(item => item.actorId === actorId)?.actorName
    || (post?.authorId === actorId ? post.authorName : '')
    || profiles.find(item => item.id === actorId)?.displayName
    || '';
};

/** 用事件对应的正文/姓名补齐记忆桥，避免长期记忆只剩“参与了评论”这类空动作。 */
const buildMomentsMemoryEventDetail = (args: {
  entry: Pick<MomentsEventLedgerEntry, 'actorId' | 'sourceId'>;
  post?: MomentsPost;
  comments?: MomentsComment[];
  reactions?: MomentsReaction[];
  media?: MomentsMediaRef[];
  profiles?: MomentsProfile[];
}): MomentsMemoryEventDetail => {
  const { entry, post } = args;
  const comments = args.comments || [];
  const reactions = args.reactions || [];
  const profiles = args.profiles || [];
  const comment = comments.find(item => item.id === entry.sourceId);
  const reaction = reactions.find(item => item.id === entry.sourceId);
  const replyTarget = comment?.replyToCommentId
    ? comments.find(item => item.id === comment.replyToCommentId)?.actorName
    : actorNameFromMomentsSnapshot(comment?.replyToActorId, post, comments, reactions, profiles);
  const mediaDescription = (args.media || []).map(item => item.prompt?.trim()).filter(Boolean).slice(0, 3).join('；');
  return {
    actorName: comment?.actorName || reaction?.actorName || actorNameFromMomentsSnapshot(entry.actorId, post, comments, reactions, profiles),
    content: comment?.content,
    replyToActorName: replyTarget,
    mediaDescription,
  };
};

const loadMomentsMemoryEventDetail = async (
  entry: Pick<MomentsEventLedgerEntry, 'actorId' | 'sourceId' | 'postId'>,
  post?: MomentsPost,
): Promise<MomentsMemoryEventDetail> => {
  if (!entry.postId) return {};
  const [comments, reactions, media, actorProfile] = await Promise.all([
    DB.getMomentsCommentsByPostId(entry.postId),
    DB.getMomentsReactionsByPostId(entry.postId),
    DB.getMomentsMediaByPostId(entry.postId),
    DB.getMomentsProfile(entry.actorId),
  ]);
  const comment = comments.find(item => item.id === entry.sourceId);
  const targetActorId = comment?.replyToActorId;
  const targetProfile = targetActorId ? await DB.getMomentsProfile(targetActorId) : undefined;
  return buildMomentsMemoryEventDetail({
    entry, post, comments, reactions, media,
    profiles: [actorProfile, targetProfile].filter((item): item is MomentsProfile => Boolean(item)),
  });
};

/** 明确 NPC 转正时复用协同工作的相关记忆排序；新旧两套记忆都纳入，最终只给制卡器五条。 */
const loadNpcCharacterCardMemories = async (source: CharacterProfile, npc: MomentsProfile): Promise<string[]> => {
  const palaceNodes = await MemoryNodeDB.getByCharId(source.id).catch(() => [] as MemoryNode[]);
  const fragmentNodes: MemoryNode[] = (source.memories || []).map((memory, index) => {
    const parsedAt = Date.parse(memory.date);
    const createdAt = Number.isFinite(parsedAt) ? parsedAt : index + 1;
    return {
      id: `moments-card-fragment:${source.id}:${memory.id}`,
      charId: source.id,
      content: memory.summary,
      room: 'living_room', tags: [], importance: 5, mood: memory.mood || 'neutral', embedded: false,
      createdAt, lastAccessedAt: createdAt, accessCount: 0,
    };
  });
  const refinedNodes: MemoryNode[] = Object.entries(source.refinedMemories || {}).map(([date, content], index) => {
    const parsedAt = Date.parse(date);
    const createdAt = Number.isFinite(parsedAt) ? parsedAt : index + 1;
    return {
      id: `moments-card-refined:${source.id}:${date}`,
      charId: source.id,
      content, room: 'living_room', tags: [], importance: 6, mood: 'archive', embedded: false,
      createdAt, lastAccessedAt: createdAt, accessCount: 0,
    };
  });
  const deduped = [...palaceNodes, ...fragmentNodes, ...refinedNodes].filter((node, index, all) => {
    const normalized = node.content.replace(/\s+/g, ' ').trim();
    return normalized && all.findIndex(candidate => candidate.content.replace(/\s+/g, ' ').trim() === normalized) === index;
  });
  const query = [npc.displayName, npc.relationLabel, npc.bio, source.name, source.description].filter(Boolean).join('\n');
  return selectCollaborationMemories(deduped, query, 5).map(node => node.content.trim());
};

const MomentMediaGrid = React.memo(({ media, onOpen, onGenerate, generatingIds }: { media: MomentsMediaRef[]; onOpen: (item: MomentsMediaRef) => void; onGenerate: (item: MomentsMediaRef) => void; generatingIds: Set<string> }) => {
  if (media.length === 0) return null;
  const gridClass = media.length === 1
    ? 'grid-cols-1 max-w-[218px]'
    : media.length === 4 ? 'grid-cols-2 max-w-[218px]' : 'grid-cols-3 max-w-[330px]';
  return (
    <div className={`mt-2.5 grid gap-1 ${gridClass}`}>
      {media.map(item => {
        const placeholder = item.generated && (!item.url || item.url.startsWith('moments-photo-pending:'));
        const generating = generatingIds.has(item.id) || item.generationStatus === 'generating';
        const failed = item.generationStatus === 'failed';
        return placeholder ? (
          <button type="button" key={item.id} className="flex aspect-square flex-col items-center justify-center gap-1.5 bg-gradient-to-br from-[#f2efff] via-[#faf7ff] to-[#fff1f6] px-3 text-center" onClick={() => onGenerate(item)}>
            <Sparkle size={22} className={generating ? 'animate-pulse text-violet-400' : 'text-violet-400'} />
            <span className="line-clamp-3 text-[10px] leading-relaxed text-violet-700">{generating ? '正在合成照片…' : failed ? '合成失败，点击重试' : item.prompt || '点击合成照片'}</span>
          </button>
        ) : (
          <button type="button" key={item.id} className="aspect-square overflow-hidden bg-slate-100 text-left" onClick={() => onOpen(item)}>
            <TokenImg value={item.url} alt="朋友圈图片" className="h-full w-full object-cover" loading="lazy" />
          </button>
        );
      })}
    </div>
  );
});

const MomentsApp: React.FC = () => {
  const { closeApp, userProfile, characters, characterGroups, groups, apiConfig, apiPresets, addCharacter, updateCharacter, addToast } = useOS();
  const [view, setView] = useState<View>('feed');
  const [profile, setProfile] = useState<MomentsProfile>(() => defaultProfile(userProfile.name, userProfile.avatar));
  const [timelineProfile, setTimelineProfile] = useState<MomentsProfile>(() => defaultProfile(userProfile.name, userProfile.avatar));
  const [posts, setPosts] = useState<MomentsPost[]>([]);
  const [mediaByPost, setMediaByPost] = useState<Record<string, MomentsMediaRef[]>>({});
  const [reactionsByPost, setReactionsByPost] = useState<Record<string, MomentsReaction[]>>({});
  const [commentsByPost, setCommentsByPost] = useState<Record<string, MomentsComment[]>>({});
  const [settings, setSettings] = useState<MomentsSettings>(DEFAULT_SETTINGS);
  const [momentsApiDraft, setMomentsApiDraft] = useState<MomentsApiConfig>(() => momentsApiFromMain(apiConfig));
  const [sharedAmsgWorker, setSharedAmsgWorker] = useState<MomentsWorkerConfig | undefined>(undefined);
  const [momentsApiModels, setMomentsApiModels] = useState<string[]>([]);
  const [momentsApiBusy, setMomentsApiBusy] = useState<'models' | 'test' | 'sync' | null>(null);
  const [momentsApiStatus, setMomentsApiStatus] = useState('');
  const [pendingJobs, setPendingJobs] = useState<MomentsPendingJob[]>([]);
  const [workerDiagnostics, setWorkerDiagnostics] = useState<MomentsWorkerDiagnostics | null>(null);
  const [friends, setFriends] = useState<MomentsProfile[]>([]);
  const [npcProfiles, setNpcProfiles] = useState<MomentsProfile[]>([]);
  const [tempStrangers, setTempStrangers] = useState<MomentsTempStranger[]>([]);
  const [strangerListOpen, setStrangerListOpen] = useState(false);
  const [activeStranger, setActiveStranger] = useState<MomentsProfile | null>(null);
  const [strangerTranscript, setStrangerTranscript] = useState<MomentsTempTranscript[]>([]);
  const [strangerDraft, setStrangerDraft] = useState('');
  const [strangerBusy, setStrangerBusy] = useState(false);
  const [strangerDeleteTarget, setStrangerDeleteTarget] = useState<MomentsTempStranger | null>(null);
  const [gallery, setGallery] = useState<GalleryImage[]>([]);
  const [composeOpen, setComposeOpen] = useState(false);
  const [galleryPickerOpen, setGalleryPickerOpen] = useState(false);
  const [draftContent, setDraftContent] = useState('');
  const [draftMedia, setDraftMedia] = useState<MomentsMediaRef[]>([]);
  const [draftVisibility, setDraftVisibility] = useState<MomentsVisibilityMode>('public');
  const [draftAudience, setDraftAudience] = useState<string[]>([]);
  const [draftGroupIds, setDraftGroupIds] = useState<string[]>([]);
  const [visibilityGroupName, setVisibilityGroupName] = useState('');
  const [photoPromptOpen, setPhotoPromptOpen] = useState(false);
  const [draftPhotoPrompt, setDraftPhotoPrompt] = useState('');
  const [privacyPickerOpen, setPrivacyPickerOpen] = useState(false);
  const [activeCommentPostId, setActiveCommentPostId] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<MomentsComment | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [selectedMedia, setSelectedMedia] = useState<MomentsMediaRef | null>(null);
  const [deleteCommentTarget, setDeleteCommentTarget] = useState<MomentsComment | null>(null);
  const [shareTargetPost, setShareTargetPost] = useState<MomentsPost | null>(null);
  const [busy, setBusy] = useState(false);
  const [generatingMediaIds, setGeneratingMediaIds] = useState<Set<string>>(() => new Set());
  const [deleteTarget, setDeleteTarget] = useState<MomentsPost | null>(null);
  const [dataReady, setDataReady] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const commentLongPressTimer = useRef<number | null>(null);
  const commentLongPressTriggered = useRef(false);
  const replanTimers = useRef(new Map<string, number>());
  const queuedReplans = useRef(new Map<string, { post: MomentsPost; comment: MomentsComment }>());
  const settingsRef = useRef(settings);
  const workerPullInFlight = useRef(false);
  const workerPullRetryAt = useRef(0);
  const workerSyncInFlight = useRef(false);
  const dueJobsInFlight = useRef(false);
  const characterPostCheckInFlight = useRef(false);
  const characterPostCheckRetryAt = useRef(0);
  const legacyNpcCardMigrationInFlight = useRef(false);
  const friendPromotionInFlight = useRef(new Set<string>());
  const runtimeSyncInFlight = useRef(false);
  const runtimeSyncQueued = useRef(false);
  const runtimeSyncTimer = useRef<number | null>(null);
  const offlineRuntimeWasEnabled = useRef(false);

  useEffect(() => { settingsRef.current = settings; }, [settings]);

  const loadData = useCallback(async () => {
    const [storedProfile, storedPosts, storedSettings, allGallery, storedStrangers, storedJobs, storedNpcs, storedLedger] = await Promise.all([
      DB.getMomentsProfile(USER_PROFILE_ID), DB.getMomentsPosts(), DB.getMomentsSettings(), DB.getGalleryImages(), DB.getMomentsTempStrangers(), DB.getMomentsPendingJobs(), DB.getMomentsProfilesByActorType('npc'), DB.getMomentsEventLedger(),
    ]);
    const globalAmsg = await ActiveMsgStore.getGlobalConfig().catch(() => null);
    const sharedWorker = globalAmsg?.workerUrl?.trim()
      ? { url: globalAmsg.workerUrl.trim(), clientToken: globalAmsg.serverToken?.trim() || '', userId: globalAmsg.userId?.trim() || undefined }
      : undefined;
    const resolvedProfile = storedProfile || defaultProfile(userProfile.name, userProfile.avatar);
    if (!storedProfile) await DB.saveMomentsProfile(resolvedProfile);
    if (!storedSettings) await DB.saveMomentsSettings(DEFAULT_SETTINGS);
    const resolvedSettings = {
      ...DEFAULT_SETTINGS, ...(storedSettings || {}),
      characterPostingModes: storedSettings?.characterPostingModes || {},
      npcPostingModes: storedSettings?.npcPostingModes || {},
      characterInteractionModes: storedSettings?.characterInteractionModes || {},
      visibilityGroups: storedSettings?.visibilityGroups || [],
    };
    const nextPosts = storedPosts.sort((a, b) => (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0) || b.createdAt - a.createdAt);
    const [mediaEntries, reactionEntries, rawCommentEntries] = await Promise.all([
      Promise.all(nextPosts.map(async post => [post.id, await DB.getMomentsMediaByPostId(post.id)] as const)),
      Promise.all(nextPosts.map(async post => [post.id, await DB.getMomentsReactionsByPostId(post.id)] as const)),
      Promise.all(nextPosts.map(async post => [post.id, await DB.getMomentsCommentsByPostId(post.id)] as const)),
    ]);
    // 旧版本可能并发消费同一条 pending 任务，留下不同 id 但内容完全相同的计划评论。
    // 只清理同一帖、同一人、同一目标、十分钟内的 planned 精确重复，避免误删真实的再次发言。
    const duplicateCommentIds = new Map<string, string[]>();
    const commentEntries = rawCommentEntries.map(([postId, comments]) => {
      const seen = new Map<string, MomentsComment>();
      const kept: MomentsComment[] = [];
      for (const comment of comments) {
        const signature = [comment.actorId, comment.replyToCommentId || '', comment.replyToActorId || '', comment.content.trim()].join('\u0001');
        const previous = seen.get(signature);
        if (comment.source === 'planned' && previous?.source === 'planned' && comment.createdAt - previous.createdAt <= 10 * 60_000) {
          duplicateCommentIds.set(postId, [...(duplicateCommentIds.get(postId) || []), comment.id]);
          continue;
        }
        seen.set(signature, comment);
        kept.push(comment);
      }
      return [postId, kept] as const;
    });
    for (const [postId, ids] of duplicateCommentIds) {
      const indexes = (await DB.getMomentsMemoryIndexesByPostId(postId)).filter(item => ids.includes(item.sourceId));
      await removeMomentsSourcesFromMemoryPalace(postId, ids, indexes.map(item => item.memoryNodeId).filter((id): id is string => Boolean(id)));
      await DB.deleteMomentsCommentsCascade(postId, ids);
      const createdAt = Date.now();
      await Promise.all(ids.map(id => DB.saveMomentsSyncOutboxItem({
        id: `moments-outbox-moment-delete-comment-${id}`,
        type: 'delete', payload: { postId, actorId: USER_PROFILE_ID, sourceId: `moment-delete-comment-${id}`, deletedSourceId: id, createdAt },
        createdAt, retryCount: 0,
      })));
    }
    const syncedFriends = await Promise.all(characters.map(async char => {
      const id = `moments:character:${char.id}`;
      const existing = await DB.getMomentsProfile(id);
      const next: MomentsProfile = {
        id, actorType: 'character', displayName: char.name, avatar: char.avatar,
        characterId: char.id, friendshipState: 'friend', cover: existing?.cover || defaultCover,
        bio: existing?.bio || '', parentCharacterId: existing?.parentCharacterId,
        relationLabel: existing?.relationLabel, updatedAt: Date.now(),
      };
      // 只同步角色基础身份；未来用户在朋友圈为角色设置的 cover/bio 不会被角色卡更新冲掉。
      await DB.saveMomentsProfile(next);
      return next;
    }));
    // 旧版把已阅、图片、点赞和无正文评论都拆成了长期记忆。
    // 每次进入朋友圈都用原始账本幂等校正，无需用户手动删除已经产生的脏节点。
    const mediaSnapshot = Object.fromEntries(mediaEntries) as Record<string, MomentsMediaRef[]>;
    const reactionSnapshot = Object.fromEntries(reactionEntries) as Record<string, MomentsReaction[]>;
    const commentSnapshot = Object.fromEntries(commentEntries) as Record<string, MomentsComment[]>;
    const profileSnapshot = [resolvedProfile, ...syncedFriends, ...storedNpcs];
    const postSnapshot = new Map(nextPosts.map(post => [post.id, post]));
    const detailsBySourceId = Object.fromEntries(storedLedger.map(entry => {
      const post = entry.postId ? postSnapshot.get(entry.postId) : undefined;
      return [entry.sourceId, buildMomentsMemoryEventDetail({
        entry, post,
        comments: entry.postId ? commentSnapshot[entry.postId] : [],
        reactions: entry.postId ? reactionSnapshot[entry.postId] : [],
        media: entry.postId ? mediaSnapshot[entry.postId] : [],
        profiles: profileSnapshot,
      })];
    }));
    await Promise.all(syncedFriends.flatMap(friend => friend.characterId ? [repairMomentsMemoryPalaceForCharacter({
      charId: friend.characterId,
      selfActorId: friend.id,
      entries: storedLedger,
      posts: nextPosts,
      detailsBySourceId,
    })] : []));
    setProfile(resolvedProfile);
    setTimelineProfile(current => current.id === USER_PROFILE_ID ? resolvedProfile : current);
    setPosts(nextPosts);
    setSettings(resolvedSettings);
    setMomentsApiDraft(resolvedSettings.momentsApi || momentsApiFromMain(apiConfig));
    setSharedAmsgWorker(sharedWorker);
    setPendingJobs(storedJobs);
    setFriends(syncedFriends);
    // 已转正的旧 NPC 行保留作幂等凭据，但不再作为“可添加的临时 NPC”显示。
    setNpcProfiles(storedNpcs.filter(npc => npc.friendshipState !== 'friend' && !npc.characterId));
    setTempStrangers(storedStrangers.filter(stranger => !stranger.addedAsFriendAt));
    setMediaByPost(mediaSnapshot);
    setReactionsByPost(reactionSnapshot);
    setCommentsByPost(commentSnapshot);
    setGallery(allGallery.sort((a, b) => b.timestamp - a.timestamp));
    setDataReady(true);
  }, [apiConfig, characters, userProfile.avatar, userProfile.name]);

  useEffect(() => { void loadData(); }, [loadData]);

  useEffect(() => {
    if (!dataReady || legacyNpcCardMigrationInFlight.current) return;
    const legacyCharacters = characters.filter(character => character.systemPrompt?.includes('现在用户已正式添加你为好友'));
    if (!legacyCharacters.length) return;
    legacyNpcCardMigrationInFlight.current = true;
    void (async () => {
      let migrated = 0;
      for (const legacy of legacyCharacters) {
        const source = characters
          .filter(candidate => candidate.id !== legacy.id && (legacy.description?.includes(candidate.name) || legacy.systemPrompt?.includes(candidate.name)))
          .sort((a, b) => b.name.length - a.name.length)[0];
        if (!source) continue;
        const descriptionWithoutSource = legacy.description?.startsWith(source.name)
          ? legacy.description.slice(source.name.length).replace(/^的/, '')
          : legacy.description;
        const relationLabel = legacy.systemPrompt.match(/角色人设中已有的([^，。\n]+)[，。]/)?.[1]?.trim()
          || descriptionWithoutSource?.split(/[，。]/)[0]?.trim()
          || '稳定关系人物';
        const legacyBio = legacy.systemPrompt.split('\n').find(line => line.trim() && !line.includes('现在用户已正式添加你为好友'))?.trim()
          || legacy.description || relationLabel;
        const npc: MomentsProfile = {
          id: `moments:character:${legacy.id}`, actorType: 'npc', displayName: legacy.name, avatar: legacy.avatar,
          bio: legacyBio, parentCharacterId: source.id, relationLabel, friendshipState: 'friend', updatedAt: Date.now(),
        };
        const relatedMemories = await loadNpcCharacterCardMemories(source, npc);
        const collaborationContext = await buildCollaborationContextSnapshot({
          char: source, user: userProfile, mode: 'focused',
          taskText: `为明确 NPC ${npc.displayName} 制作角色卡`,
        });
        const card = await planMomentsNpcCharacterProfile({
          config: settingsRef.current.momentsApi || momentsApiFromMain(apiConfig), npc,
          sourceCharacter: { name: source.name, description: source.description || '', systemPrompt: source.systemPrompt || '', worldview: source.worldview },
          user: { name: userProfile.name, bio: userProfile.bio || '' },
          relatedMemories,
          collaborationContext,
        });
        await updateCharacter(legacy.id, { name: card.name, description: card.description, systemPrompt: card.systemPrompt, worldview: card.worldview });
        const existingProfile = await DB.getMomentsProfile(`moments:character:${legacy.id}`);
        if (existingProfile) await DB.saveMomentsProfile({ ...existingProfile, bio: legacyBio, parentCharacterId: source.id, relationLabel, updatedAt: Date.now() });
        migrated += 1;
      }
      if (migrated) addToast(`已升级 ${migrated} 位旧版朋友圈 NPC 的角色人设`, 'success');
    })().finally(() => { legacyNpcCardMigrationInFlight.current = false; });
  }, [addToast, apiConfig, characters, dataReady, updateCharacter]);

  const allDraftUrls = useMemo(() => new Set(draftMedia.map(item => item.url)), [draftMedia]);

  const resetDraft = () => {
    setDraftContent('');
    setDraftMedia([]);
    setDraftVisibility('public');
    setDraftAudience([]);
    setDraftGroupIds([]);
    setDraftPhotoPrompt('');
    setPhotoPromptOpen(false);
    setGalleryPickerOpen(false);
  };

  const visibleActorIdsForPost = useCallback((visibility: MomentsPost['visibility']) => {
    if (visibility.mode === 'private') return [USER_PROFILE_ID];
    if (visibility.mode === 'partial') return unique([USER_PROFILE_ID, ...visibility.allowedActorIds]);
    if (visibility.mode === 'exclude') return unique([USER_PROFILE_ID, ...friends.map(friend => friend.id).filter(id => !visibility.blockedActorIds.includes(id))]);
    return unique([USER_PROFILE_ID, ...friends.map(friend => friend.id)]);
  }, [friends]);

  const interactionActorsForPost = useCallback((post: MomentsPost) => friends.filter(actor => {
    if (actor.id === post.authorId || !isPostVisibleTo(post, actor.id)) return false;
    const characterId = actor.characterId || '';
    return (settings.characterInteractionModes?.[characterId] || 'normal') !== 'off';
  }), [friends, settings.characterInteractionModes]);

  const recordMomentsEvent = useCallback(async (entry: { postId?: string; actorId: string; type: MomentsEventType; sourceId: string; visibleToActorIds: string[]; createdAt?: number; deletedSourceId?: string }) => {
    const createdAt = entry.createdAt || Date.now();
    const sourcePost = entry.postId ? (await DB.getMomentsPosts()).find(item => item.id === entry.postId) : undefined;
    const ledgerEntry = {
      id: `moments-event-${entry.sourceId}`, eventId: `moments-event-${entry.sourceId}`, ...entry, createdAt,
      sourceType: 'moments' as const, participantActorIds: unique([entry.actorId, ...entry.visibleToActorIds]),
      visibilitySnapshot: sourcePost?.visibility, status: entry.type === 'delete' ? 'deleted' as const : 'active' as const,
    };
    await DB.saveMomentsEventLedger(ledgerEntry);
    const needsMemoryDetail = ['post', 'seen', 'comment', 'reply', 'share'].includes(entry.type);
    const memoryDetail = needsMemoryDetail ? await loadMomentsMemoryEventDetail(ledgerEntry, sourcePost) : undefined;
    // 删除事件只用于撤销远端旧内容，不能再给角色写入一条“该动态仍可见”的记忆索引。
    if (entry.type !== 'delete') {
      // “有可见权”不等于“已看见”。索引只写给事实参与者、seen 事件中的角色，或手动转发的接收者。
      const indexedActorIds = unique([
        entry.actorId.startsWith('moments:character:') ? entry.actorId : '',
        ...(entry.type === 'share' ? entry.visibleToActorIds.filter(id => id.startsWith('moments:character:')) : []),
      ].filter(Boolean));
      for (const actorId of indexedActorIds) {
        await DB.saveMomentsMemoryIndex({ id: `moments-memory-${entry.sourceId}-${actorId}`, actorId, sourceId: entry.sourceId, postId: entry.postId, createdAt });
      }
    }
    // 真正参与过的正式角色，或已由转发明确投递的正式角色，才进入记忆宫殿。
    const directCharacterId = entry.actorId.startsWith('moments:character:') ? entry.actorId.slice('moments:character:'.length) : '';
    const deliveredCharacterIds = entry.type === 'share'
      ? entry.visibleToActorIds.filter(id => id.startsWith('moments:character:')).map(id => id.slice('moments:character:'.length))
      : [];
    const targetCharacterIds = unique([directCharacterId, ...deliveredCharacterIds].filter(Boolean));
    if (targetCharacterIds.length && entry.postId) {
      await Promise.all(targetCharacterIds.map(async charId => {
        const memoryNodeId = await mirrorMomentsEventToMemoryPalace({ charId, entry: ledgerEntry, post: sourcePost, selfActorId: `moments:character:${charId}`, detail: memoryDetail });
        if (memoryNodeId) await DB.saveMomentsMemoryIndex({ id: `moments-palace-${entry.sourceId}-${charId}`, actorId: `moments:character:${charId}`, sourceId: entry.sourceId, postId: entry.postId, memoryNodeId, createdAt });
      }));
    }
    await DB.saveMomentsSyncOutboxItem({
      id: `moments-outbox-${entry.sourceId}`,
      type: entry.type === 'post' ? 'post' : entry.type === 'delete' ? 'delete' : entry.type === 'share' ? 'seen' : 'interaction',
      payload: { ...entry, createdAt }, createdAt, retryCount: 0,
    });
  }, []);

  /**
   * 醋意只从“角色确实刷到 / 被直接回复 / 实际参与”的事实生长，绝不从所有可见角色里猜。
   * 这里不上传原文，传给关系 Worker 的只是稳定 eventId、原因类别和有限强度。
   */
  const reportMomentsJealousy = useCallback(async (args: {
    post: MomentsPost;
    sourceId: string;
    content: string;
    kind: 'moments_romance' | 'moments_intimate_comment';
    directActorId?: string;
  }) => {
    const text = args.content.trim();
    if (!text || !/(?:爱你|喜欢你|好爱|好喜欢|想你|宝贝|宝宝|亲亲|约会|暧昧|男朋友|女朋友|老公|老婆|对象|只爱|最爱|吃醋)/.test(text)) return;
    const directCharId = args.directActorId?.startsWith('moments:character:') ? args.directActorId.slice('moments:character:'.length) : undefined;
    const namedOtherIds = characters
      .filter(char => char.id !== directCharId && char.name && text.includes(char.name))
      .map(char => char.id);
    const [postReceipts, directChar] = await Promise.all([
      Promise.all(characters.map(async char => [char.id, await DB.getMomentsSeenReceiptsByActorId(`moments:character:${char.id}`)] as const)),
      Promise.resolve(directCharId ? characters.find(char => char.id === directCharId) : undefined),
    ]);
    const targets = postReceipts.flatMap(([charId, receipts]) => {
      const char = characters.find(item => item.id === charId);
      if (!char) return [];
      const actuallySaw = receipts.some(receipt => receipt.postId === args.post.id && ['delivered', 'seen', 'selected_for_interaction'].includes(receipt.state));
      // 被用户直接回复的角色不需要额外“刷到”回执；这条回复本身就是投递事实。
      if (!actuallySaw && charId !== directChar?.id) return [];
      const otherInvolved = (directCharId && directCharId !== charId) || namedOtherIds.some(id => id !== charId);
      if (!otherInvolved) return [];
      const intensity = args.kind === 'moments_intimate_comment' ? 17 : 11;
      return [{ char, signals: [{
        eventId: `moments-jealousy:${args.sourceId}:${charId}`,
        kind: args.kind, intensity,
        reason: args.kind === 'moments_intimate_comment' ? '实际看见用户在朋友圈与其他角色的亲密互动' : '实际看见带有暧昧指向的朋友圈动态',
        createdAt: Date.now(),
      }] }];
    });
    if (!targets.length) return;
    try { await reportRelationshipJealousyEvents(targets, settings.jealousyForceEnabled); }
    catch (error: any) { addToast(`醋意关系事实暂未同步：${error?.message || '网络错误'}`, 'error'); }
  }, [addToast, characters, settings.jealousyForceEnabled]);

  const saveMomentsSettingsPatch = useCallback(async (patch: Partial<MomentsSettings>) => {
    // 保持这个写入器稳定：Worker 失败时若它随 settings 改变而重建，依赖它的
    // effect 会再次拉取 Worker，容易形成失败→重渲染→再请求的循环。
    const next = { ...settingsRef.current, ...patch, updatedAt: Date.now() };
    await DB.saveMomentsSettings(next);
    settingsRef.current = next;
    setSettings(next);
    return next;
  }, []);

  const createVisibilityGroup = useCallback(async () => {
    const name = visibilityGroupName.trim();
    if (!name) return;
    const actorIds = unique(draftAudience);
    if (!actorIds.length) { addToast('先至少选一位朋友，再保存为朋友圈分组', 'error'); return; }
    const group = { id: `moments-group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: name.slice(0, 24), actorIds, updatedAt: Date.now() };
    await saveMomentsSettingsPatch({ visibilityGroups: [...(settings.visibilityGroups || []), group] });
    setDraftGroupIds(prev => unique([...prev, group.id]));
    setVisibilityGroupName('');
    addToast(`已建立朋友圈分组「${group.name}」`, 'success');
  }, [addToast, draftAudience, saveMomentsSettingsPatch, settings.visibilityGroups, visibilityGroupName]);

  const flushMomentsWorker = useCallback(async (workerOverride?: MomentsWorkerConfig) => {
    if (!settings.offlineSyncEnabled) return;
    const worker = workerOverride || sharedAmsgWorker;
    if (!isMomentsWorkerReady(worker)) return;
    if (workerSyncInFlight.current) return;
    workerSyncInFlight.current = true;
    setMomentsApiBusy('sync');
    try {
      const [items, jobs] = await Promise.all([DB.getMomentsSyncOutbox(), DB.getMomentsPendingJobs()]);
      if (!hasPendingMomentsSyncWork(items, jobs)) {
        await saveMomentsSettingsPatch({ syncStatus: 'synced', syncError: undefined, lastSyncAt: Date.now() });
        setMomentsApiStatus('当前没有待同步内容，Worker 同步状态正常');
        return;
      }
      const userId = worker.userId?.trim() || `moments-user-${USER_PROFILE_ID}`;
      const result = await syncMomentsOutbox(worker, outboxToSyncPayload(items, jobs, userId));
      const acknowledged = new Set([...result.acceptedEventIds, ...result.acceptedTaskIds]);
      // Worker 只接受每类最多 200 条；只删除本次明确确认的 outbox，剩余项目留到下一批，绝不丢。
      await Promise.all(items.filter(item => acknowledged.has(item.id)).map(item => DB.deleteMomentsSyncOutboxItem(item.id)));
      await saveMomentsSettingsPatch({ syncStatus: 'synced', syncError: undefined, lastSyncAt: Date.now() });
      setMomentsApiStatus(`Worker 已确认 ${acknowledged.size} 条同步项（本次处理 ${result.accepted} 条新增记录）`);
    } catch (error: any) {
      await saveMomentsSettingsPatch({ syncStatus: 'failed', syncError: error?.message || '同步失败' });
      setMomentsApiStatus(`Worker 同步失败：${error?.message || '网络错误'}`);
    } finally { workerSyncInFlight.current = false; setMomentsApiBusy(null); }
  }, [saveMomentsSettingsPatch, settings.offlineSyncEnabled, sharedAmsgWorker]);

  const pullMomentsWorker = useCallback(async (workerOverride?: MomentsWorkerConfig) => {
    if (!settings.offlineSyncEnabled) return;
    const worker = workerOverride || sharedAmsgWorker;
    if (!isMomentsWorkerReady(worker)) return;
    if (workerPullInFlight.current) return;
    if (!workerOverride && Date.now() < workerPullRetryAt.current) return;
    workerPullInFlight.current = true;
    try {
      const userId = worker.userId?.trim() || `moments-user-${USER_PROFILE_ID}`;
      const [remoteJobs, deliveries] = await Promise.all([pullMomentsTasks(worker, userId), pullMomentsDeliveries(worker, userId)]);
      if (!remoteJobs.length && !deliveries.length) return;
      const local = await DB.getMomentsPendingJobs();
      const localById = new Map(local.map(job => [job.id, job]));
      for (const remote of remoteJobs) {
        const next: MomentsPendingJob = { ...remote, createdAt: remote.createdAt || Date.now(), updatedAt: remote.updatedAt || Date.now() };
        const existing = localById.get(next.id);
        // 终态不被较旧的远端 pending/running 覆盖；远端 running 也绝不回退为本地 pending。
        if (!existing || !['done', 'cancelled'].includes(existing.state) || ['done', 'cancelled'].includes(next.state)) await DB.saveMomentsPendingJob(next);
      }
      // Worker 已到点投递的任务不再抢 claim；本机只负责把预写的事实落入 IndexedDB。
      for (const delivery of deliveries) {
        const previous = localById.get(delivery.taskId);
        if (previous?.state === 'done' || previous?.state === 'cancelled') continue;
        await DB.saveMomentsPendingJob({
          id: delivery.taskId, type: delivery.payload.taskType === 'post' ? 'post' : 'interaction', actorId: typeof delivery.payload.actorId === 'string' ? delivery.payload.actorId : undefined,
          postId: typeof delivery.payload.postId === 'string' ? delivery.payload.postId : undefined,
          dueAt: delivery.createdAt || Date.now(), state: 'pending', createdAt: delivery.createdAt || Date.now(), updatedAt: Date.now(),
          payload: { ...delivery.payload, __workerDelivered: true }, threadVersion: typeof delivery.payload.threadVersion === 'number' ? delivery.payload.threadVersion : 1,
        });
      }
      if (deliveries.length) await acknowledgeMomentsDeliveries(worker, userId, deliveries.map(item => item.id));
      setPendingJobs(await DB.getMomentsPendingJobs());
      workerPullRetryAt.current = 0;
    } catch (error: any) {
      // Worker/DNS 暂不可达时不要让页面每次重绘都再等 30 秒；手动「立即重试」
      // 仍可绕过这个两分钟冷却。
      workerPullRetryAt.current = Date.now() + 2 * 60_000;
      await saveMomentsSettingsPatch({ syncStatus: 'failed', syncError: error?.message || '拉取 Worker 任务失败' });
      setMomentsApiStatus(`Worker 任务拉取失败：${error?.message || '网络错误'}`);
    } finally { workerPullInFlight.current = false; }
  }, [saveMomentsSettingsPatch, settings.offlineSyncEnabled, sharedAmsgWorker]);

  const refreshMomentsWorkerDiagnostics = useCallback(async (workerOverride?: MomentsWorkerConfig) => {
    const worker = workerOverride || sharedAmsgWorker;
    if (!isMomentsWorkerReady(worker)) return;
    try {
      const userId = worker.userId?.trim() || `moments-user-${USER_PROFILE_ID}`;
      const [diagnostics, items, jobs] = await Promise.all([
        getMomentsWorkerDiagnostics(worker, userId),
        DB.getMomentsSyncOutbox(),
        DB.getMomentsPendingJobs(),
      ]);
      setWorkerDiagnostics(diagnostics);
      // 诊断路由能成功读取计数，证明 D1 已经恢复。只清理这类已证实过时的额度错误，
      // 其他同步错误仍然保留，不用一次只读诊断冒充同步成功。
      if (settingsRef.current.syncStatus === 'failed' && isD1DailyLimitError(settingsRef.current.syncError)) {
        const noPendingWork = !hasPendingMomentsSyncWork(items, jobs);
        await saveMomentsSettingsPatch({
          syncStatus: noPendingWork ? 'synced' : 'idle',
          syncError: undefined,
          ...(noPendingWork ? { lastSyncAt: diagnostics.checkedAt } : {}),
        });
      }
    } catch (error: any) {
      setMomentsApiStatus(`Worker 诊断读取失败：${error?.message || '网络错误'}`);
    }
  }, [saveMomentsSettingsPatch, sharedAmsgWorker]);

  const refreshAmsgWorker = useCallback(async () => {
    const globalAmsg = await ActiveMsgStore.getGlobalConfig().catch(() => null);
    const next = globalAmsg?.workerUrl?.trim()
      ? { url: globalAmsg.workerUrl.trim(), clientToken: globalAmsg.serverToken?.trim() || '', userId: globalAmsg.userId?.trim() || undefined }
      : undefined;
    setSharedAmsgWorker(next);
    setMomentsApiStatus(next
      ? '已读取主动消息 2.0 Worker；朋友圈将复用同一地址、用户 ID、共享密钥和 D1'
      : '主动消息 2.0 尚未配置 Worker 地址，朋友圈云端同步暂不可用');
    if (next) void flushMomentsWorker(next);
  }, [flushMomentsWorker]);

  const applyDueMomentsJobs = useCallback(async () => {
    if (dueJobsInFlight.current) return;
    dueJobsInFlight.current = true;
    try {
    const now = Date.now();
    const due = (await DB.getMomentsPendingJobs()).filter(job => job.state === 'pending' && job.dueAt <= now);
    if (!due.length) return;
    const worker = sharedAmsgWorker;
    const workerUserId = worker?.userId?.trim() || `moments-user-${USER_PROFILE_ID}`;
    for (const job of due) {
      let executable = job;
      const payload = job.payload || {};
      try {
        if (isMomentsWorkerReady(worker) && payload.__workerDelivered !== true) {
          let claim;
          try {
            claim = await claimMomentsTask(worker, workerUserId, job.id);
          } catch (error: any) {
            // 网络抖动时不把本地任务标失败、更不能绕过 claim 强行执行；保留 pending 等下一轮重试。
            const waiting = { ...job, state: 'pending' as const, updatedAt: Date.now(), error: `等待 Worker 认领：${error?.message || '网络错误'}` };
            await DB.saveMomentsPendingJob(waiting);
            setPendingJobs(prev => prev.map(item => item.id === job.id ? waiting : item));
            continue;
          }
          if (!claim.claimed) {
            // 已被另一台设备认领：本机不执行，等待 pull 取得它的最终状态或 Worker 的 stale recovery。
            const running = { ...job, state: 'running' as const, updatedAt: Date.now(), error: '已由另一台设备认领，等待 Worker 回执' };
            await DB.saveMomentsPendingJob(running);
            setPendingJobs(prev => prev.map(item => item.id === job.id ? running : item));
            continue;
          }
          executable = { ...job, ...(claim.task || {}), state: 'running' as const, updatedAt: Date.now() };
          await DB.saveMomentsPendingJob(executable);
          setPendingJobs(prev => prev.map(item => item.id === job.id ? executable : item));
        }
        if (executable.type === 'post' && payload.post && typeof payload.post === 'object') {
          const scheduledPost = payload.post as MomentsPost;
          const scheduledMedia = Array.isArray(payload.media) ? payload.media as MomentsMediaRef[] : [];
          const exists = posts.some(item => item.id === scheduledPost.id) || (await DB.getMomentsPosts()).some(item => item.id === scheduledPost.id);
          if (!exists) {
            await Promise.all([DB.saveMomentsPost(scheduledPost), DB.saveMomentsVisibilitySnapshot(scheduledPost.visibility), DB.saveMomentsMediaRefs(scheduledMedia)]);
            await recordMomentsEvent({ postId: scheduledPost.id, actorId: scheduledPost.authorId, type: 'post', sourceId: scheduledPost.id, visibleToActorIds: [USER_PROFILE_ID, ...friends.map(friend => friend.id)], createdAt: scheduledPost.createdAt });
            await Promise.all(scheduledMedia.map(media => recordMomentsEvent({ postId: scheduledPost.id, actorId: scheduledPost.authorId, type: 'media', sourceId: media.id, visibleToActorIds: [USER_PROFILE_ID, ...friends.map(friend => friend.id)], createdAt: media.createdAt })));
            setPosts(prev => [scheduledPost, ...prev]);
            if (scheduledMedia.length) setMediaByPost(prev => ({ ...prev, [scheduledPost.id]: scheduledMedia }));
          }
        } else if (executable.type === 'interaction' && executable.postId && typeof payload.actorId === 'string') {
          const actorId = payload.actorId;
          const actor = friends.find(item => item.id === actorId) || npcProfiles.find(item => item.id === actorId);
          const post = posts.find(item => item.id === executable.postId) || (await DB.getMomentsPosts()).find(item => item.id === executable.postId);
          if (payload.kind === 'reaction') {
            const existing = (reactionsByPost[executable.postId] || []).some(item => item.actorId === actorId);
            if (!existing) {
              const reaction: MomentsReaction = {
                id: String(payload.sourceId || executable.id), postId: executable.postId, actorId,
                actorType: payload.actorType === 'npc' ? 'npc' : 'character', actorName: actor?.displayName || String(payload.actorName || '角色'),
                actorAvatar: actor?.avatar, createdAt: now,
              };
              await DB.saveMomentsReaction(reaction);
              if (post) await recordMomentsEvent({ postId: post.id, actorId, type: 'reaction', sourceId: reaction.id, visibleToActorIds: visibleActorIdsForPost(post.visibility), createdAt: now });
              setReactionsByPost(prev => ({ ...prev, [job.postId!]: [...(prev[job.postId!] || []), reaction] }));
            }
          } else if (payload.kind === 'comment' && typeof payload.content === 'string') {
            const commentId = String(payload.sourceId || executable.id);
            const existing = (await DB.getMomentsCommentsByPostId(executable.postId)).some(item => item.id === commentId);
            if (!existing) {
              const comment: MomentsComment = {
                id: commentId, postId: executable.postId, actorId,
                actorType: payload.actorType === 'npc' ? 'npc' : 'character', actorName: actor?.displayName || String(payload.actorName || '角色'),
                actorAvatar: actor?.avatar, content: String(payload.content),
                replyToCommentId: typeof payload.replyToCommentId === 'string' ? payload.replyToCommentId : undefined,
                replyToActorId: typeof payload.replyToActorId === 'string' ? payload.replyToActorId : undefined,
                createdAt: now, source: 'planned',
              };
              await DB.saveMomentsComment(comment);
              if (post) await recordMomentsEvent({ postId: post.id, actorId, type: comment.replyToActorId ? 'reply' : 'comment', sourceId: comment.id, visibleToActorIds: visibleActorIdsForPost(post.visibility), createdAt: now });
              setCommentsByPost(prev => ({ ...prev, [job.postId!]: [...(prev[job.postId!] || []).filter(item => item.id !== comment.id), comment] }));
            }
          }
        }
        const done = { ...executable, state: 'done' as const, updatedAt: Date.now(), error: undefined };
        await DB.saveMomentsPendingJob(done);
        setPendingJobs(prev => prev.map(item => item.id === job.id ? done : item));
        if (isMomentsWorkerReady(worker) && payload.__workerDelivered !== true) await completeMomentsTask(worker, workerUserId, job.id, 'done').catch(() => undefined);
      } catch (error: any) {
        const failed = { ...executable, state: 'failed' as const, updatedAt: Date.now(), error: error?.message || '朋友圈任务执行失败' };
        await DB.saveMomentsPendingJob(failed);
        setPendingJobs(prev => prev.map(item => item.id === job.id ? failed : item));
        if (isMomentsWorkerReady(worker) && payload.__workerDelivered !== true) await completeMomentsTask(worker, workerUserId, job.id, 'failed', failed.error).catch(() => undefined);
      }
    }
    void flushMomentsWorker();
    } finally {
      dueJobsInFlight.current = false;
    }
  }, [flushMomentsWorker, friends, npcProfiles, posts, reactionsByPost, recordMomentsEvent, sharedAmsgWorker, visibleActorIdsForPost]);

  const buildInteractionActorContexts = useCallback(async (actors: MomentsProfile[]): Promise<MomentsInteractionActorContext[]> => {
    const characterIds = unique(actors.map(actor => actor.characterId).filter((id): id is string => Boolean(id)));
    const relevantGroups = groups.filter(group => group.members.some(memberId => characterIds.includes(memberId)));
    const [privateRows, groupRows] = await Promise.all([
      Promise.all(characterIds.map(async id => [id, await DB.getMessagesByCharId(id, true)] as const)),
      Promise.all(relevantGroups.map(async group => [group, await DB.getGroupMessages(group.id)] as const)),
    ]);
    const privateByCharacter = new Map(privateRows);
    const characterName = new Map(characters.map(character => [character.id, character.name]));
    const formatLine = (message: { role: string; charId: string; content: string; timestamp: number }, selfId?: string) => {
      const who = message.role === 'user' ? userProfile.name : message.charId === selfId ? '你' : (characterName.get(message.charId) || '群友');
      const date = new Date(message.timestamp);
      return `[${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}] ${who}：${(message.content || '').replace(/\s+/g, ' ').slice(0, 240)}`;
    };
    return actors.map(actor => {
      const character = actor.characterId ? characters.find(item => item.id === actor.characterId) : undefined;
      if (!character) return {
        actorId: actor.id,
        persona: [actor.relationLabel, actor.bio].filter(Boolean).join('；').slice(0, 1200),
        userRelationship: actor.friendshipState === 'friend' ? '这是用户的朋友圈好友；亲疏以当前评论区事实为准。' : '这是一次偶然刷到动态的路人，不得假装与用户熟识。',
      };
      const privateChat = (privateByCharacter.get(character.id) || []).slice(-18).map(message => formatLine(message, character.id)).join('\n');
      const sharedGroupChat = groupRows
        .filter(([group]) => group.members.includes(character.id))
        .flatMap(([group, messages]) => messages.slice(-(group.privateContextCap ?? 24)).map(message => `[群：${group.name}] ${formatLine(message, character.id)}`))
        .slice(-48)
        .join('\n');
      const pulse = character.relationshipPulse;
      const relationship = [
        pulse ? `当前关系数值：好感 ${pulse.affection}，醋意 ${pulse.jealousy}，思念基线 ${pulse.baselineLonging}` : '',
        character.impression ? `角色眼中的用户：${JSON.stringify(character.impression).slice(0, 1400)}` : '',
      ].filter(Boolean).join('\n');
      return {
        actorId: actor.id,
        persona: [`备注：${character.description || '无'}`, character.systemPrompt || actor.bio || ''].join('\n').slice(0, 4500),
        userRelationship: relationship || '没有额外关系快照，按近期私聊与当前朋友圈互动判断。',
        privateChat: privateChat || '近期没有私聊原文。',
        sharedGroupChat: sharedGroupChat || '近期没有可用的共同群聊原文。',
      };
    });
  }, [characters, groups, userProfile.name]);

  const syncCloudRuntime = useCallback(async () => {
    const currentSettings = settingsRef.current;
    if (!dataReady || !isMomentsWorkerReady(sharedAmsgWorker)) return;
    if (runtimeSyncInFlight.current) {
      runtimeSyncQueued.current = true;
      return;
    }
    runtimeSyncInFlight.current = true;
    try {
      if (!currentSettings.offlineSyncEnabled) {
        await syncMomentsRuntime(sharedAmsgWorker, {
          userId: sharedAmsgWorker.userId?.trim() || `moments-user-${USER_PROFILE_ID}`,
          enabled: false,
          autoInteractionEnabled: currentSettings.autoInteractionEnabled,
          credentialId: MOMENTS_LLM_CREDENTIAL_ID,
          replaceAll: true,
          actors: [],
          updatedAt: Date.now(),
        });
        setMomentsApiStatus('离线生活线已关闭，Worker 上的朋友圈主体已停用');
        return;
      }
      const config = currentSettings.momentsApi || momentsApiFromMain(apiConfig);
      if (!isMomentsApiReady(config)) {
        setMomentsApiStatus('离线朋友圈未同步：请先配置完整的朋友圈低价模型');
        return;
      }
      const credential = buildMomentsLlmCredentialRow(config);
      if (!credential) throw new Error('朋友圈低价模型的 URL、Key 或 Model 不完整');
      // API Key 沿用主动消息 2.0 的加密凭据表；角色快照只携带不透明 credId。
      await ActiveMsgClient.putLlmCredentials([credential]);
      const actors = [...friends, ...npcProfiles].filter(actor => actor.actorType === 'character' || actor.actorType === 'npc');
      const contexts = await buildInteractionActorContexts(actors);
      const contextByActor = new Map(contexts.map(context => [context.actorId, context]));
      const privacyCandidates = actors.map(actor => ({
        actorId: actor.id,
        name: actor.displayName,
        groupName: actor.characterId ? characters.find(character => character.id === actor.characterId)?.groupId : undefined,
      }));
      const runtimeActors: MomentsCloudActorRuntime[] = actors.map(actor => {
        const context = contextByActor.get(actor.id);
        const ownCharacter = actor.characterId ? characters.find(item => item.id === actor.characterId) : undefined;
        const parentCharacter = actor.parentCharacterId ? characters.find(item => item.id === actor.parentCharacterId) : undefined;
        // 正式角色用自己的钟；明确 NPC 没有独立时区时继承所属主角色。
        // 两者都没有设置才跟随用户手机，与主动消息 2.0 的时区口径一致。
        const timezoneId = resolveCharTimeZone(ownCharacter)
          || resolveCharTimeZone(parentCharacter)
          || Intl.DateTimeFormat().resolvedOptions().timeZone
          || 'UTC';
        const postingMode = actor.actorType === 'npc'
          ? currentSettings.npcPostingModes?.[actor.id] || 'low'
          : currentSettings.characterPostingModes?.[actor.characterId || ''] || 'off';
        const interactionMode = actor.actorType === 'npc'
          ? 'normal'
          : currentSettings.characterInteractionModes?.[actor.characterId || ''] || 'normal';
        const ownGallery = actor.characterId ? gallery.filter(image => image.charId === actor.characterId).slice(0, 18) : [];
        return {
          actorId: actor.id,
          actorType: actor.actorType as 'character' | 'npc',
          ...(actor.characterId ? { characterId: actor.characterId } : {}),
          ...(actor.parentCharacterId ? { parentCharacterId: actor.parentCharacterId } : {}),
          displayName: actor.displayName,
          ...(actor.avatar ? { avatar: actor.avatar } : {}),
          ...(actor.bio ? { bio: actor.bio } : {}),
          postingMode,
          interactionMode,
          timezoneId,
          timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
          pack: {
            persona: context?.persona || [actor.relationLabel, actor.bio].filter(Boolean).join('；'),
            userRelationship: context?.userRelationship || '以近期对话和当前朋友圈事实判断关系。',
            privateChat: context?.privateChat || '近期没有私聊原文。',
            sharedGroupChat: context?.sharedGroupChat || '近期没有可用的共同群聊原文。',
            recentPosts: posts.filter(post => post.authorId === actor.id).slice(0, 8).map(post => ({ content: post.content, createdAt: post.createdAt })),
            galleryOptions: ownGallery.map(image => ({
              id: image.id, url: image.url, savedDate: image.savedDate,
              review: image.review?.slice(0, 180), context: image.chatContext?.slice(-3).join(' · ').slice(0, 260),
            })),
            privacyCandidates: privacyCandidates.filter(candidate => candidate.actorId !== actor.id),
          },
        };
      });
      const result = await syncMomentsRuntime(sharedAmsgWorker, {
        userId: sharedAmsgWorker.userId?.trim() || `moments-user-${USER_PROFILE_ID}`,
        enabled: currentSettings.enabled,
        autoInteractionEnabled: currentSettings.autoInteractionEnabled,
        credentialId: MOMENTS_LLM_CREDENTIAL_ID,
        replaceAll: true,
        actors: runtimeActors,
        updatedAt: Date.now(),
      });
      setMomentsApiStatus(`离线生活线已同步：${runtimeActors.length} 位主体，Worker 更新 ${result.upserted} 行`);
    } catch (error: any) {
      setMomentsApiStatus(`离线生活线同步失败：${error?.message || '网络错误'}`);
      await saveMomentsSettingsPatch({ syncStatus: 'failed', syncError: error?.message || '离线生活线同步失败' });
    } finally {
      runtimeSyncInFlight.current = false;
      if (runtimeSyncQueued.current) {
        runtimeSyncQueued.current = false;
        if (runtimeSyncTimer.current !== null) window.clearTimeout(runtimeSyncTimer.current);
        runtimeSyncTimer.current = window.setTimeout(() => { void syncCloudRuntime(); }, 500);
      }
    }
  }, [apiConfig, buildInteractionActorContexts, characters, dataReady, friends, gallery, npcProfiles, posts, saveMomentsSettingsPatch, settings.autoInteractionEnabled, settings.characterInteractionModes, settings.characterPostingModes, settings.enabled, settings.momentsApi, settings.npcPostingModes, sharedAmsgWorker]);

  const planPostInteractions = useCallback(async (post: MomentsPost, earliestDueAt = 0) => {
    if (!settings.autoInteractionEnabled) return;
    const config = settings.momentsApi || momentsApiFromMain(apiConfig);
    if (!isMomentsApiReady(config)) {
      setMomentsApiStatus('朋友圈副 API 未配置，已保留帖子但未规划自动互动');
      return;
    }
    const characterActors = selectInteractionActors(post.id, interactionActorsForPost(post));
    // 明确 NPC 与随机路人均不计入正式好友人数分档。明确 NPC 最多三位；完全无关的路人每帖稳定随机 2–5 位。
    const npcActors = [...npcProfiles]
      .filter(actor => actor.id !== post.authorId && isPostVisibleTo(post, actor.id))
      .sort((a, b) => stableHash(`${post.id}:npc:${a.id}`) - stableHash(`${post.id}:npc:${b.id}`))
      .slice(0, 3);
    const passerbyActors = post.visibility.mode === 'public' ? randomPasserbyActorsForPost(post.id) : [];
    const actors = [...characterActors, ...npcActors, ...passerbyActors];
    if (!actors.length) return;
    try {
      setMomentsApiStatus('正在生成本条朋友圈的统一互动计划…');
      const actorContexts = await buildInteractionActorContexts(actors);
      const plan = await planMomentsInteractions({ config, post, actors, actorContexts, now: Date.now(), maxComments: 8 });
      const plannedByActor = new Map(plan.interactions.map(item => [item.actorId, item]));
      // 路人就是本帖偶然刷到的 2–5 人：模型可决定说什么；若模型漏掉某人，至少保留一次自然点赞。
      // 路人评论最多三条，其余自动降为点赞，避免评论区被陌生人淹没。
      let passerbyCommentCount = 0;
      const passerbyInteractions = passerbyActors.map(actor => {
        const planned = plannedByActor.get(actor.id);
        const wantsComment = planned?.kind === 'comment' && passerbyCommentCount < 3;
        if (wantsComment) passerbyCommentCount += 1;
        const passerbyBaseAt = Math.max(Date.now(), earliestDueAt);
        const fallbackDueAt = passerbyBaseAt + (2 + stableHash(`${post.id}:${actor.id}:delay`) % 58) * 60_000;
        const dueAt = planned ? Math.max(passerbyBaseAt + 2 * 60_000, Math.min(planned.dueAt, passerbyBaseAt + 60 * 60_000)) : fallbackDueAt;
        return planned ? { ...planned, dueAt, kind: wantsComment ? 'comment' as const : 'reaction' as const, content: wantsComment ? planned.content : undefined } : {
          actorId: actor.id, actorType: 'npc' as const, actorName: actor.displayName, kind: 'reaction' as const,
          content: undefined,
          dueAt,
          idempotencyKey: `moments:${post.id}:v1:${actor.id}:reaction`,
        };
      });
      const interactions = [...plan.interactions.filter(item => !passerbyActors.some(actor => actor.id === item.actorId)), ...passerbyInteractions]
        .sort((a, b) => a.dueAt - b.dueAt);
      const jobs: MomentsPendingJob[] = interactions.flatMap(item => {
        const mode = settings.characterInteractionModes?.[friends.find(friend => friend.id === item.actorId)?.characterId || ''] || 'normal';
        if (mode === 'reaction_only' && item.kind === 'comment') return [{
          id: `moments-job-${post.id}:${item.actorId}:reaction`, type: 'interaction' as const, actorId: item.actorId, postId: post.id, dueAt: Math.max(item.dueAt, earliestDueAt),
          state: 'pending' as const, createdAt: Date.now(), threadVersion: plan.threadVersion,
          payload: { actorId: item.actorId, actorType: item.actorType, actorName: item.actorName, kind: 'reaction', sourceId: `${post.id}:${item.actorId}:reaction` },
        }];
        const sourceId = `${post.id}:${item.actorId}:${item.kind}`;
        return [{
          id: `moments-job-${sourceId}`,
          type: 'interaction', actorId: item.actorId, postId: post.id, dueAt: Math.max(item.dueAt, earliestDueAt),
          state: 'pending', createdAt: Date.now(), threadVersion: plan.threadVersion,
          payload: { actorId: item.actorId, actorType: item.actorType, actorName: item.actorName, kind: item.kind, content: item.content || '', sourceId },
        }];
      });
      const seenAt = Date.now();
      await Promise.all([...jobs.map(job => DB.saveMomentsPendingJob(job)), ...actors.map(actor => DB.saveMomentsSeenReceipt({ id: `moment-seen-${post.id}-${actor.id}`, postId: post.id, actorId: actor.id, state: 'selected_for_interaction', reason: 'auto-interaction-plan', createdAt: seenAt, updatedAt: seenAt }))]);
      // 入选互动即代表角色已经刷到这条动态：用原始 seen 事件和 EventBox 记录，而不是另做影子账本。
      await Promise.all(actors.map(actor => recordMomentsEvent({ postId: post.id, actorId: actor.id, type: 'seen', sourceId: `${post.id}:seen:${actor.id}`, visibleToActorIds: [actor.id], createdAt: seenAt })));
      setPendingJobs(prev => [...prev.filter(job => !jobs.some(next => next.id === job.id)), ...jobs].sort((a, b) => a.dueAt - b.dueAt));
      setMomentsApiStatus(`互动计划已保存：${jobs.length} 条（含 ${passerbyActors.length} 位随机路人），按时间错峰执行（本帖只调用 1 次副 API）`);
      void flushMomentsWorker();
    } catch (error: any) {
      setMomentsApiStatus(`互动规划失败：${error?.message || '未知错误'}`);
      addToast(error?.message || '朋友圈互动规划失败，帖子本身仍已保存', 'error');
    }
  }, [addToast, apiConfig, buildInteractionActorContexts, flushMomentsWorker, friends, interactionActorsForPost, npcProfiles, settings.autoInteractionEnabled, settings.characterInteractionModes, settings.momentsApi]);

  const replanPostInteractions = useCallback(async (post: MomentsPost, latestComment: MomentsComment) => {
    if (!settings.autoInteractionEnabled) return;
    const config = settings.momentsApi || momentsApiFromMain(apiConfig);
    if (!isMomentsApiReady(config)) return;
    const [storedJobs, storedReactions, storedComments] = await Promise.all([
      DB.getMomentsPendingJobs(), DB.getMomentsReactionsByPostId(post.id), DB.getMomentsCommentsByPostId(post.id),
    ]);
    const nextVersion = Math.max(1, ...storedJobs.filter(job => job.postId === post.id).map(job => job.threadVersion || 1)) + 1;
    const participantIds = new Set([...storedReactions, ...storedComments].map(item => item.actorId));
    const passerbyActors = post.visibility.mode === 'public'
      ? randomPasserbyActorsForPost(post.id).filter(actor => participantIds.has(actor.id))
      : [];
    const formalActors = [
      ...friends.filter(actor => {
        if (!isPostVisibleTo(post, actor.id)) return false;
        const mode = settings.characterInteractionModes?.[actor.characterId || ''] || 'normal';
        return mode !== 'off';
      }),
      ...npcProfiles.filter(actor => isPostVisibleTo(post, actor.id)),
    ];
    const priorityIds = new Set([...participantIds, post.authorId]);
    const priorityActors = [...formalActors, ...passerbyActors].filter(actor => priorityIds.has(actor.id));
    const discoveryActors = selectInteractionActors(`${post.id}:reply:v${nextVersion}`, formalActors.filter(actor => !priorityIds.has(actor.id)));
    const actors = [...new Map([...priorityActors, ...discoveryActors].filter(actor => actor.id !== USER_PROFILE_ID).map(actor => [actor.id, actor])).values()];
    if (!actors.length) return;
    try {
      const samePost = storedJobs.filter(job => job.postId === post.id && job.state === 'pending');
      const comments = [...storedComments, latestComment]
        .filter((comment, index, all) => all.findIndex(item => item.id === comment.id) === index)
        .slice(-12)
        .map(comment => ({ id: comment.id, actorId: comment.actorId, actorName: comment.actorName, content: comment.content }));
      const reactions = storedReactions.map(reaction => ({ actorId: reaction.actorId, actorName: reaction.actorName }));
      const actorContexts = await buildInteractionActorContexts(actors);
      const plan = await planMomentsInteractions({
        config, post, actors, actorContexts, now: Date.now(), maxComments: 3, threadVersion: nextVersion,
        contextComments: comments, contextReactions: reactions, replyRound: true,
      });
      const jobs = plan.interactions.map(item => {
        const sourceId = `${post.id}:${item.actorId}:${item.kind}:v${plan.threadVersion}`;
        return { id: `moments-job-${sourceId}`, type: 'interaction' as const, actorId: item.actorId, postId: post.id, dueAt: item.dueAt, state: 'pending' as const, createdAt: Date.now(), threadVersion: plan.threadVersion, payload: { actorId: item.actorId, actorType: item.actorType, actorName: item.actorName, kind: item.kind, content: item.content || '', replyToCommentId: item.replyToCommentId, replyToActorId: item.replyToActorId, sourceId } };
      });
      await Promise.all([
        // 先生成新计划，再取消旧任务。副 API 失败时不会把原本尚未发出的互动一起清空。
        ...samePost.map(job => DB.saveMomentsPendingJob({ ...job, state: 'cancelled', updatedAt: Date.now(), error: '用户新增评论后统一重排' })),
        ...jobs.map(job => DB.saveMomentsPendingJob(job)),
        ...actors.map(actor => DB.saveMomentsSeenReceipt({ id: `moment-seen-${post.id}-${actor.id}`, postId: post.id, actorId: actor.id, state: 'selected_for_interaction', reason: 'comment-replan', createdAt: Date.now(), updatedAt: Date.now() })),
      ]);
      await Promise.all(actors.map(actor => recordMomentsEvent({ postId: post.id, actorId: actor.id, type: 'seen', sourceId: `${post.id}:seen:${actor.id}`, visibleToActorIds: [actor.id], createdAt: Date.now() })));
      setPendingJobs(await DB.getMomentsPendingJobs());
      setMomentsApiStatus(`评论区已统一重排：旧的未发互动已取消，新增 ${jobs.length} 条（本轮 1 次副 API）`);
      void flushMomentsWorker();
    } catch (error: any) {
      setMomentsApiStatus(`评论区重排失败：${error?.message || '未知错误'}`);
      addToast(error?.message || '评论区重排失败，已保留你的评论', 'error');
    }
  }, [addToast, apiConfig, buildInteractionActorContexts, flushMomentsWorker, friends, npcProfiles, recordMomentsEvent, settings.autoInteractionEnabled, settings.characterInteractionModes, settings.momentsApi]);

  const queuePostInteractionReplan = useCallback((post: MomentsPost, latestComment: MomentsComment) => {
    queuedReplans.current.set(post.id, { post, comment: latestComment });
    const currentTimer = replanTimers.current.get(post.id);
    if (currentTimer !== undefined) window.clearTimeout(currentTimer);
    const timer = window.setTimeout(() => {
      const queued = queuedReplans.current.get(post.id);
      queuedReplans.current.delete(post.id);
      replanTimers.current.delete(post.id);
      if (queued) void replanPostInteractions(queued.post, queued.comment);
    }, 700);
    replanTimers.current.set(post.id, timer);
  }, [replanPostInteractions]);

  useEffect(() => () => {
    for (const timer of replanTimers.current.values()) window.clearTimeout(timer);
    replanTimers.current.clear();
  }, []);

  const runCharacterPostChecks = useCallback(async () => {
    // 开启真正离线模式后，发帖判断由 Worker 独占；页面不再保留第二套 10 分钟轮询。
    if (settings.offlineSyncEnabled && isMomentsWorkerReady(sharedAmsgWorker)) return;
    // 不能在一次页面渲染里把所有角色/NPC 同时送进副 API。每轮只检查一位主体，
    // 并将轮次错开 10 分钟；这是“生活化地慢慢出现”，不是打开朋友圈就集体刷屏。
    if (characterPostCheckInFlight.current || Date.now() < characterPostCheckRetryAt.current) return;
    characterPostCheckInFlight.current = true;
    characterPostCheckRetryAt.current = Date.now() + 10 * 60_000;
    try {
    const config = settings.momentsApi || momentsApiFromMain(apiConfig);
    if (!isMomentsApiReady(config)) return;
    const now = new Date();
    const dayKey = localDateKey(now);
    let plannedOne = false;
    const postingActors = [
      ...characters.flatMap(character => {
        const actor = friends.find(item => item.characterId === character.id);
        return actor ? [{ actor, actorType: 'character' as const, sourceId: character.id, scheduleCharacterId: character.id, mode: settings.characterPostingModes?.[character.id] || 'off' as MomentsPostingMode, bio: [character.description, character.systemPrompt].filter(Boolean).join('\n') }] : [];
      }),
      ...npcProfiles.map(npc => ({
        actor: npc, actorType: 'npc' as const, sourceId: npc.id, scheduleCharacterId: npc.parentCharacterId,
        mode: settings.npcPostingModes?.[npc.id] || 'low' as MomentsPostingMode,
        bio: [npc.relationLabel, npc.bio].filter(Boolean).join(' · '),
      })),
    ];
    for (const candidate of postingActors) {
      const { actor, actorType, sourceId, scheduleCharacterId, mode, bio } = candidate;
      if (mode === 'off' || mode === 'view_only') continue;
      if (mode === 'low' && !isLowPostingDay(sourceId, dayKey)) continue;
      const opportunityTotal = postingOpportunityCount(mode);
      // 高频一天三段机会；每段只判断一次，模型仍可返回“不发”，不会为了凑频率硬发。
      const opportunity = mode === 'high' ? Math.min(2, Math.floor(now.getHours() / 8)) : 0;
      if (opportunity >= opportunityTotal) continue;
      const checkKey = `moments-role-check:${dayKey}:${sourceId}:${opportunity}`;
      try { if (localStorage.getItem(checkKey) === 'done') continue; } catch { /* ignore storage errors */ }
      try {
        const schedule = scheduleCharacterId ? await DB.getDailySchedule(scheduleCharacterId, dayKey) : null;
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const activeSlot = schedule?.slots.reduce<typeof schedule.slots[number] | undefined>((latest, slot) => {
          const [hour, minute] = slot.startTime.split(':').map(Number);
          return Number.isFinite(hour) && Number.isFinite(minute) && hour * 60 + minute <= currentMinutes ? slot : latest;
        }, undefined);
        // 日程明确在睡觉/休息时不做自主发帖；聊天触发另走结构化 intent，不被这个定时检查误拦。
        if (activeSlot && isSleepingSlot(activeSlot.activity)) {
          try { localStorage.setItem(checkKey, 'done'); } catch { /* ignore storage errors */ }
          continue;
        }
        if (plannedOne) break;
        plannedOne = true;
        const photoSeed = `${dayKey}:${sourceId}:${opportunity}:photo`;
        const ownGallery = actor.characterId
          ? gallery.filter(image => image.charId === actor.characterId).slice(0, 18)
          : [];
        const plan = await planMomentsCharacterPost({
          config, actor: { ...actor, bio }, mode,
          recentPosts: posts.filter(post => post.authorId === actor.id), now: Date.now(),
          preferPhoto: stableHash(photoSeed) % 100 < 80,
          galleryOptions: ownGallery.map(image => ({
            id: image.id, savedDate: image.savedDate,
            review: image.review?.slice(0, 160), context: image.chatContext?.slice(-3).join(' · ').slice(0, 240),
          })),
          privacyCandidates: [...friends, ...npcProfiles].filter(friend => friend.id !== actor.id).map(friend => ({
            actorId: friend.id, name: friend.displayName,
            groupName: characters.find(item => item.id === friend.characterId)?.groupId || undefined,
          })),
        });
        if (plan.shouldPost && plan.content) {
          const createdAt = Date.now();
          const postId = `moment-${actorType}-${stableHash(sourceId).toString(36)}-${dayKey}-${opportunity}`;
          const selectedGalleryImage = plan.galleryImageId ? ownGallery.find(image => image.id === plan.galleryImageId) : undefined;
          const mediaId = selectedGalleryImage ? `moments-gallery-${postId}` : plan.photoPrompt ? `moments-generated-${postId}` : undefined;
          const post: MomentsPost = {
            id: postId, authorType: actorType, authorId: actor.id, authorName: actor.displayName, authorAvatar: actor.avatar,
            content: plan.content, mediaIds: mediaId ? [mediaId] : [], createdAt, source: actorType,
            visibility: {
              id: `moments-visibility-${postId}`, postId, mode: plan.visibilityMode || 'public',
              allowedActorIds: [], blockedActorIds: plan.visibilityMode === 'exclude' ? (plan.excludedActorIds || []) : [],
              groupIds: [], version: 1, capturedAt: createdAt,
            },
          };
          const media: MomentsMediaRef[] = selectedGalleryImage && mediaId
            ? [{ id: mediaId, postId, url: selectedGalleryImage.url, galleryImageId: selectedGalleryImage.id, createdAt, generated: false, generationStatus: 'ready' }]
            : mediaId ? [{ id: mediaId, postId, url: `moments-photo-pending:${mediaId}`, createdAt, generated: true, prompt: plan.photoPrompt, includeCharacter: plan.photoIncludesAuthor === true, generationStatus: 'pending' }] : [];
          // 未启用真正离线模式时保留旧兼容路径：页面内预写，之后由本机或 Worker 投递。
          const dueAt = Math.max(createdAt + 6 * 60_000, Math.min(plan.dueAt || createdAt + 18 * 60_000, createdAt + 24 * 60 * 60_000));
          const job: MomentsPendingJob = {
            id: `moments-job-post-${postId}`, type: 'post', actorId: actor.id, postId, dueAt, state: 'pending', createdAt,
            payload: { kind: 'post', actorName: actor.displayName, sourceId: postId, post, media },
          };
          await DB.saveMomentsPendingJob(job);
          setPendingJobs(prev => [...prev.filter(item => item.id !== job.id), job].sort((a, b) => a.dueAt - b.dueAt));
          // 互动也在此刻一次性预写；其触发时间本身比发帖时间晚，不在 Worker 上二次调模型。
          void planPostInteractions(post, dueAt + 60_000);
          void flushMomentsWorker();
        }
        try { localStorage.setItem(checkKey, 'done'); } catch { /* ignore storage errors */ }
      } catch (error: any) {
        setMomentsApiStatus(`${actorType === 'npc' ? 'NPC' : '角色'} ${actor.displayName} 的朋友圈检查失败：${error?.message || '未知错误'}`);
      }
    }
    } finally { characterPostCheckInFlight.current = false; }
  }, [apiConfig, characters, friends, gallery, npcProfiles, planPostInteractions, posts, settings.characterPostingModes, settings.momentsApi, settings.npcPostingModes, settings.offlineSyncEnabled, sharedAmsgWorker]);

  // 到点任务先在本机落地执行；若配置了 Worker，同时把事件/任务同步到云端。
  useEffect(() => {
    void applyDueMomentsJobs();
    const timer = window.setInterval(() => { void applyDueMomentsJobs(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [applyDueMomentsJobs]);

  useEffect(() => {
    if (settings.offlineSyncEnabled && sharedAmsgWorker?.url) void pullMomentsWorker();
  }, [pullMomentsWorker, settings.offlineSyncEnabled, sharedAmsgWorker?.url]);

  useEffect(() => {
    if (settings.offlineSyncEnabled && sharedAmsgWorker?.url) void flushMomentsWorker();
  }, [flushMomentsWorker, settings.offlineSyncEnabled, sharedAmsgWorker?.url]);

  useEffect(() => {
    if (!dataReady || !sharedAmsgWorker?.url) return;
    const wasEnabled = offlineRuntimeWasEnabled.current;
    offlineRuntimeWasEnabled.current = settings.offlineSyncEnabled;
    // 初次打开且本来就是关闭状态时不做无意义写入；只在开关从开→关时同步停用。
    if (!settings.offlineSyncEnabled && !wasEnabled) return;
    if (runtimeSyncTimer.current !== null) window.clearTimeout(runtimeSyncTimer.current);
    runtimeSyncTimer.current = window.setTimeout(() => { void syncCloudRuntime(); }, 700);
    return () => {
      if (runtimeSyncTimer.current !== null) window.clearTimeout(runtimeSyncTimer.current);
      runtimeSyncTimer.current = null;
    };
  }, [dataReady, settings.offlineSyncEnabled, sharedAmsgWorker?.url, syncCloudRuntime]);

  useEffect(() => {
    void runCharacterPostChecks();
    const timer = window.setInterval(() => { void runCharacterPostChecks(); }, 10 * 60_000);
    return () => window.clearInterval(timer);
  }, [runCharacterPostChecks]);

  const addPhotoPlaceholder = () => {
    const prompt = draftPhotoPrompt.trim();
    if (!prompt) { addToast('请先写下照片内容描述', 'error'); return; }
    if (draftMedia.length >= 9) { addToast('一条朋友圈最多 9 张图片', 'error'); return; }
    const id = `moments-generated-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setDraftMedia(prev => [...prev, { id, postId: '', url: `moments-photo-pending:${id}`, createdAt: Date.now(), generated: true, prompt, generationStatus: 'pending' }]);
    setDraftPhotoPrompt('');
    setPhotoPromptOpen(false);
  };

  const toggleGalleryImage = (image: GalleryImage) => {
    if (allDraftUrls.has(image.url)) {
      setDraftMedia(prev => prev.filter(item => item.url !== image.url));
      return;
    }
    if (draftMedia.length >= 9) { addToast('一条朋友圈最多 9 张图片', 'error'); return; }
    setDraftMedia(prev => [...prev, {
      id: `moments-media-draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      postId: '', url: image.url, galleryImageId: image.id, createdAt: Date.now(),
    }]);
  };

  const addUploadedMedia = async (files: FileList | null) => {
    if (!files?.length) return;
    const room = 9 - draftMedia.length;
    if (room <= 0) { addToast('一条朋友圈最多 9 张图片', 'error'); return; }
    try {
      const next = await Promise.all(Array.from(files).slice(0, room).map(async file => ({
        id: `moments-media-draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        postId: '',
        url: await putImageBlob(await processImageToBlob(file, { maxWidth: 1600, quality: 0.9 })),
        createdAt: Date.now(),
      })));
      setDraftMedia(prev => [...prev, ...next]);
      setGalleryPickerOpen(false);
      addToast(`已从手机系统相册选择 ${next.length} 张照片`, 'success');
    } catch (error: any) {
      addToast(error?.message || '图片读取失败', 'error');
    }
  };

  const publish = async () => {
    const content = draftContent.trim();
    if (!content && draftMedia.length === 0) { addToast('写点什么，或至少选一张图片吧', 'error'); return; }
    setBusy(true);
    try {
      const now = Date.now();
      const id = `moment-${now}-${Math.random().toString(36).slice(2, 8)}`;
      // 分组只用于发帖时方便选择；这里立刻展开成角色的朋友圈身份 ID，旧帖从此不受分组变动影响。
      const groupActorIds = characters
        .filter(character => character.groupId && draftGroupIds.includes(character.groupId))
        .map(character => `moments:character:${character.id}`);
      const momentsGroupActorIds = (settings.visibilityGroups || [])
        .filter(group => draftGroupIds.includes(group.id))
        .flatMap(group => group.actorIds);
      const frozenAudience = unique([...draftAudience, ...groupActorIds, ...momentsGroupActorIds]);
      const post: MomentsPost = {
        id,
        authorType: 'user', authorId: USER_PROFILE_ID,
        authorName: profile.displayName, authorAvatar: profile.avatar,
        content, mediaIds: draftMedia.map(item => item.id), createdAt: now, source: 'manual',
        visibility: {
          id: `moments-visibility-${id}`, postId: id,
          mode: draftVisibility,
          allowedActorIds: draftVisibility === 'partial' ? frozenAudience : [],
          blockedActorIds: draftVisibility === 'exclude' ? frozenAudience : [],
          groupIds: draftGroupIds, version: 1, capturedAt: now,
        },
      };
      const storedMedia = draftMedia.map(item => ({ ...item, postId: id }));
      await Promise.all([DB.saveMomentsPost(post), DB.saveMomentsVisibilitySnapshot(post.visibility), DB.saveMomentsMediaRefs(storedMedia)]);
      await recordMomentsEvent({ postId: id, actorId: USER_PROFILE_ID, type: 'post', sourceId: id, visibleToActorIds: visibleActorIdsForPost(post.visibility), createdAt: now });
      await Promise.all(storedMedia.map(media => recordMomentsEvent({ postId: id, actorId: USER_PROFILE_ID, type: 'media', sourceId: media.id, visibleToActorIds: visibleActorIdsForPost(post.visibility), createdAt: media.createdAt })));
      void reportMomentsJealousy({ post, sourceId: id, content, kind: 'moments_romance' });
      setPosts(prev => [post, ...prev]);
      setMediaByPost(prev => ({ ...prev, [id]: storedMedia }));
      resetDraft();
      setComposeOpen(false);
      addToast('已发表到朋友圈', 'success');
      // 规划与发表解耦：帖子先成功落库，副 API 失败只影响自动互动，不影响帖子本身。
      void planPostInteractions(post);
      void flushMomentsWorker();
    } catch (error: any) {
      addToast(error?.message || '发表失败，请稍后重试', 'error');
    } finally { setBusy(false); }
  };

  const updateMomentMedia = async (postId: string, media: MomentsMediaRef) => {
    const nextMedia = { ...media };
    await DB.saveMomentsMediaRefs([nextMedia]);
    setMediaByPost(prev => ({ ...prev, [postId]: (prev[postId] || []).map(item => item.id === media.id ? nextMedia : item) }));
  };

  const generateMomentPhoto = async (post: MomentsPost, media: MomentsMediaRef) => {
    if (!media.generated || !media.prompt) return;
    if (generatingMediaIds.has(media.id)) return;
    if (!isImageGenerationConfigured(apiConfig)) { addToast('请先在设置 → 其他 API 配置生图模型', 'error'); return; }
    setGeneratingMediaIds(prev => new Set(prev).add(media.id));
    await updateMomentMedia(post.id, { ...media, generationStatus: 'generating', generationError: undefined });
    try {
      const authorProfile = friends.find(friend => friend.id === post.authorId);
      const author = authorProfile?.characterId ? characters.find(character => character.id === authorProfile.characterId) : undefined;
      const npc = post.authorType === 'npc' ? npcProfiles.find(item => item.id === post.authorId) : undefined;
      const fallback: CharacterProfile = {
        id: npc?.id || 'moments-user', name: npc?.displayName || profile.displayName || '我', avatar: npc?.avatar || profile.avatar || '',
        description: npc?.bio || '', systemPrompt: '', memories: [],
        ...(npc?.bio ? { imageProfile: { appearancePrompt: npc.bio, referenceMode: 'identity' as const } } : {}),
      };
      const generated = await generateChatImage({ prompt: media.prompt, config: apiConfig, char: author || fallback, includeCharacter: media.includeCharacter === true });
      const storedUrl = generated.dataUrl;
      const galleryId = media.galleryImageId || `moments-generated-gallery-${media.id}`;
      await DB.saveGalleryImage({ id: galleryId, charId: author?.id || npc?.id || USER_PROFILE_ID, url: storedUrl, timestamp: Date.now(), savedDate: new Date().toISOString().slice(0, 10), chatContext: [post.content || media.prompt] });
      await updateMomentMedia(post.id, { ...media, url: storedUrl, generated: true, galleryImageId: galleryId, generationStatus: 'ready', generationError: undefined });
      await recordMomentsEvent({ postId: post.id, actorId: post.authorId, type: 'media', sourceId: `${media.id}:ready`, visibleToActorIds: visibleActorIdsForPost(post.visibility), createdAt: Date.now() });
      addToast('朋友圈照片已合成并保存到相册', 'success');
    } catch (error: any) {
      const message = error?.message || '照片合成失败，请检查生图 API';
      await updateMomentMedia(post.id, { ...media, generationStatus: 'failed', generationError: message });
      addToast(message, 'error');
    } finally {
      setGeneratingMediaIds(prev => { const next = new Set(prev); next.delete(media.id); return next; });
    }
  };

  const updateCover = async (file: File | undefined) => {
    if (!file) return;
    try {
      const cover = await putImageBlob(await processImageToBlob(file, { maxWidth: 1800, quality: 0.9 }));
      const next = { ...profile, cover, updatedAt: Date.now() };
      await DB.saveMomentsProfile(next);
      setProfile(next);
      addToast('朋友圈封面已更换', 'success');
    } catch (error: any) { addToast(error?.message || '封面更新失败', 'error'); }
  };

  const setStrangerVisibility = async (value: boolean) => {
    const next = { ...settings, strangersCanViewTen: value, updatedAt: Date.now() };
    await DB.saveMomentsSettings(next);
    setSettings(next);
  };

  const setCharacterPostingMode = async (characterId: string, mode: MomentsPostingMode) => {
    const next = { ...settings, characterPostingModes: { ...(settings.characterPostingModes || {}), [characterId]: mode }, updatedAt: Date.now() };
    await DB.saveMomentsSettings(next);
    setSettings(next);
  };

  const setNpcPostingMode = async (npcId: string, mode: MomentsPostingMode) => {
    const next = { ...settings, npcPostingModes: { ...(settings.npcPostingModes || {}), [npcId]: mode }, updatedAt: Date.now() };
    await DB.saveMomentsSettings(next);
    setSettings(next);
  };

  const setCharacterInteractionMode = async (characterId: string, mode: MomentsInteractionMode) => {
    const next = { ...settings, characterInteractionModes: { ...(settings.characterInteractionModes || {}), [characterId]: mode }, updatedAt: Date.now() };
    await DB.saveMomentsSettings(next);
    setSettings(next);
  };

  const syncExplicitNpcs = async () => {
    const config = settings.momentsApi || momentsApiFromMain(apiConfig);
    if (!isMomentsApiReady(config)) { addToast('请先配置朋友圈副 API，才能从角色人设提取明确 NPC', 'error'); return; }
    setMomentsApiBusy('sync');
    setMomentsApiStatus('正在从角色人设提取明确 NPC…');
    try {
      const plans = await planMomentsNpcProfiles({ config, characters: characters.map(character => ({ id: character.id, name: character.name, description: character.description || '', systemPrompt: character.systemPrompt || '' })) });
      const createdAt = Date.now();
      const profiles: MomentsProfile[] = plans.map(plan => ({
        id: `moments:npc:${plan.sourceCharacterId}:${stableHash(plan.name).toString(36)}`,
        actorType: 'npc', displayName: plan.name, bio: plan.bio, relationLabel: plan.relationLabel,
        parentCharacterId: plan.sourceCharacterId, friendshipState: 'temporary', cover: defaultCover, updatedAt: createdAt,
      }));
      const freshPosts: MomentsPost[] = [];
      const freshMedia: MomentsMediaRef[] = [];
      for (let index = 0; index < profiles.length; index++) {
        const plan = plans[index]; const npc = profiles[index];
        if (!plan.initialPost) continue;
        const postId = `moments-npc-post-${npc.id}`;
        const existing = posts.some(post => post.id === postId);
        if (!existing) {
          const mediaId = plan.initialPhotoPrompt ? `moments-generated-${postId}` : undefined;
          freshPosts.push({ id: postId, authorType: 'npc', authorId: npc.id, authorName: npc.displayName, content: plan.initialPost, mediaIds: mediaId ? [mediaId] : [], createdAt, source: 'npc', visibility: { id: `moments-visibility-${postId}`, postId, mode: 'public', allowedActorIds: [], blockedActorIds: [], groupIds: [], version: 1, capturedAt: createdAt } });
          if (mediaId) freshMedia.push({ id: mediaId, postId, url: `moments-photo-pending:${mediaId}`, createdAt, generated: true, prompt: plan.initialPhotoPrompt, includeCharacter: plan.initialPhotoIncludesAuthor === true, generationStatus: 'pending' });
        }
      }
      const npcPostingModes = { ...(settings.npcPostingModes || {}) };
      profiles.forEach(npc => { if (!npcPostingModes[npc.id]) npcPostingModes[npc.id] = 'low'; });
      const nextSettings = { ...settings, npcPostingModes, updatedAt: Date.now() };
      await Promise.all([
        ...profiles.map(profile => DB.saveMomentsProfile(profile)),
        ...freshPosts.flatMap(post => [DB.saveMomentsPost(post), DB.saveMomentsVisibilitySnapshot(post.visibility), recordMomentsEvent({ postId: post.id, actorId: post.authorId, type: 'post', sourceId: post.id, visibleToActorIds: [USER_PROFILE_ID, ...friends.map(friend => friend.id)], createdAt })]),
        ...(freshMedia.length ? [DB.saveMomentsMediaRefs(freshMedia)] : []),
        ...freshMedia.map(media => recordMomentsEvent({ postId: media.postId, actorId: freshPosts.find(post => post.id === media.postId)?.authorId || USER_PROFILE_ID, type: 'media', sourceId: media.id, visibleToActorIds: [USER_PROFILE_ID, ...friends.map(friend => friend.id)], createdAt: media.createdAt })),
        DB.saveMomentsSettings(nextSettings),
      ]);
      setNpcProfiles(profiles);
      if (freshPosts.length) setPosts(prev => [...freshPosts, ...prev].sort((a, b) => b.createdAt - a.createdAt));
      if (freshMedia.length) setMediaByPost(prev => ({ ...prev, ...Object.fromEntries(freshMedia.map(media => [media.postId, [media]])) }));
      setSettings(nextSettings);
      setMomentsApiStatus(plans.length ? `已同步 ${plans.length} 位明确 NPC，其中 ${freshPosts.length} 条首发动态已写入朋友圈` : '当前角色人设中没有可确认的稳定 NPC；没有自动编造。');
    } catch (error: any) {
      setMomentsApiStatus(`NPC 同步失败：${error?.message || '未知错误'}`);
      addToast(error?.message || 'NPC 同步失败', 'error');
    } finally { setMomentsApiBusy(null); }
  };

  const addNpcAsFriend = async (npc: MomentsProfile) => {
    if (npc.actorType !== 'npc') return;
    const promotionKey = `npc:${npc.id}`;
    if (friendPromotionInFlight.current.has(promotionKey)) {
      addToast('正在添加，请不要重复点击', 'info');
      return;
    }
    const sameName = normalizedPersonName(npc.displayName);
    const existingFriend = friends.find(friend => normalizedPersonName(friend.displayName) === sameName);
    const existingCharacter = characters.find(character => normalizedPersonName(character.name) === sameName);
    if (npc.characterId || existingFriend || existingCharacter) {
      const existing = existingFriend || (existingCharacter ? friends.find(friend => friend.characterId === existingCharacter.id) : undefined);
      if (existing) setTimelineProfile(existing);
      addToast(`${npc.displayName} 已经是角色好友，不会重复生成人设`, 'info');
      return;
    }
    friendPromotionInFlight.current.add(promotionKey);
    setBusy(true);
    try {
      const sourceCharacter = characters.find(character => character.id === npc.parentCharacterId);
      if (!sourceCharacter) throw new Error(`找不到 ${npc.displayName} 对应的来源角色，无法安全生成独立人设`);
      const relatedMemories = await loadNpcCharacterCardMemories(sourceCharacter, npc);
      const collaborationContext = await buildCollaborationContextSnapshot({
        char: sourceCharacter, user: userProfile, mode: 'focused',
        taskText: `为明确 NPC ${npc.displayName} 制作角色卡`,
      });
      const card = await planMomentsNpcCharacterProfile({
        config: settings.momentsApi || momentsApiFromMain(apiConfig),
        npc,
        sourceCharacter: {
          name: sourceCharacter.name,
          description: sourceCharacter.description || '',
          systemPrompt: sourceCharacter.systemPrompt || '',
          worldview: sourceCharacter.worldview,
        },
        user: { name: userProfile.name, bio: userProfile.bio || '' },
        relatedMemories,
        collaborationContext,
      });
      const created = await addCharacter();
      const now = Date.now();
      const sourcePosts = posts.filter(post => post.authorId === npc.id).slice(0, 10).map(post => post.content).filter(Boolean).join('\n');
      const memory: MemoryFragment = { id: `moments-npc-memory-${npc.id}-${created.id}`, date: new Date().toISOString().slice(0, 10), summary: `通过朋友圈认识了${npc.displayName}；${npc.displayName}来自${sourceCharacter.name}的人设关系网，与${sourceCharacter.name}的关系为${npc.relationLabel || '稳定熟人'}。其公开动态摘要：\n${sourcePosts || '暂无动态。'}`, mood: 'archive' };
      await updateCharacter(created.id, {
        name: card.name,
        description: card.description,
        systemPrompt: card.systemPrompt,
        worldview: card.worldview,
        memories: [...(created.memories || []), memory],
      });
      const promoted: MomentsProfile = { ...npc, id: `moments:character:${created.id}`, actorType: 'character', characterId: created.id, friendshipState: 'friend', updatedAt: now };
      const promotedPosts = posts.filter(post => post.authorId === npc.id).map(post => ({ ...post, authorId: promoted.id, authorType: 'character' as const, updatedAt: now }));
      // 原 NPC 行改为“已转正”是持久化幂等凭据；即使刷新页面也不会再次显示添加入口。
      const promotionMarker: MomentsProfile = { ...npc, characterId: created.id, friendshipState: 'friend', updatedAt: now };
      await Promise.all([DB.saveMomentsProfile(promotionMarker), DB.saveMomentsProfile(promoted), ...promotedPosts.map(post => DB.saveMomentsPost(post))]);
      setNpcProfiles(prev => prev.filter(item => item.id !== npc.id));
      setFriends(prev => [...prev, promoted]);
      if (promotedPosts.length) setPosts(prev => prev.map(post => promotedPosts.find(next => next.id === post.id) || post));
      setTimelineProfile(promoted);
      addToast(`${npc.displayName} 已添加为角色好友`, 'success');
    } catch (error: any) { addToast(error?.message || '添加 NPC 好友失败', 'error'); }
    finally { friendPromotionInFlight.current.delete(promotionKey); setBusy(false); }
  };

  const togglePin = async (post: MomentsPost) => {
    const next = { ...post, pinned: !post.pinned, updatedAt: Date.now() };
    await DB.saveMomentsPost(next);
    setPosts(prev => prev.map(item => item.id === post.id ? next : item).sort((a, b) => (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0) || b.createdAt - a.createdAt));
  };

  const confirmDelete = async (alsoDeleteGalleryCopies: boolean) => {
    const target = deleteTarget;
    if (!target) return;
    setBusy(true);
    try {
      const media = mediaByPost[target.id] || [];
      let preservedGalleryCopies = 0;
      if (alsoDeleteGalleryCopies) {
        for (const id of unique(media.map(item => item.galleryImageId).filter(Boolean) as string[])) {
          const usage = await DB.getGalleryImageUsage(id, target.id);
          if (usage.momentsPostIds.length || usage.chatMessageIds.length || usage.socialPostIds.length) preservedGalleryCopies += 1;
          else await DB.deleteGalleryImage(id);
        }
      }
      const memoryIndexes = await DB.getMomentsMemoryIndexesByPostId(target.id);
      await removeMomentsPostFromMemoryPalace(target.id, memoryIndexes.map(item => item.memoryNodeId).filter((id): id is string => Boolean(id)));
      await DB.deleteMomentsPostCascade(target.id);
      await recordMomentsEvent({ postId: target.id, actorId: USER_PROFILE_ID, type: 'delete', sourceId: `moment-delete-${target.id}-${Date.now()}`, visibleToActorIds: [] });
      void flushMomentsWorker();
      setPosts(prev => prev.filter(item => item.id !== target.id));
      setMediaByPost(prev => { const next = { ...prev }; delete next[target.id]; return next; });
      setReactionsByPost(prev => { const next = { ...prev }; delete next[target.id]; return next; });
      setCommentsByPost(prev => { const next = { ...prev }; delete next[target.id]; return next; });
      setDeleteTarget(null);
      addToast(alsoDeleteGalleryCopies
        ? (preservedGalleryCopies ? `动态已删除；${preservedGalleryCopies} 张图片仍在其他内容中使用，已保留` : '动态和未被其他内容引用的相册副本已删除')
        : '动态已删除，相册照片已保留', 'success');
    } catch (error: any) {
      addToast(error?.message || '删除失败，请稍后重试', 'error');
    } finally { setBusy(false); }
  };

  const toggleUserReaction = async (post: MomentsPost) => {
    const current = reactionsByPost[post.id] || [];
    const existing = current.find(reaction => reaction.actorId === USER_PROFILE_ID);
    try {
      if (existing) {
        await DB.deleteMomentsReaction(existing.id);
        setReactionsByPost(prev => ({ ...prev, [post.id]: (prev[post.id] || []).filter(reaction => reaction.id !== existing.id) }));
      } else {
        const reaction: MomentsReaction = {
          id: `moment-reaction-${post.id}-${USER_PROFILE_ID}`,
          postId: post.id, actorId: USER_PROFILE_ID, actorType: 'user', actorName: profile.displayName,
          actorAvatar: profile.avatar, createdAt: Date.now(),
        };
        await DB.saveMomentsReaction(reaction);
        await recordMomentsEvent({ postId: post.id, actorId: USER_PROFILE_ID, type: 'reaction', sourceId: reaction.id, visibleToActorIds: visibleActorIdsForPost(post.visibility), createdAt: reaction.createdAt });
        setReactionsByPost(prev => ({ ...prev, [post.id]: [...(prev[post.id] || []), reaction] }));
        void flushMomentsWorker();
      }
    } catch (error: any) { addToast(error?.message || '操作失败，请稍后重试', 'error'); }
  };

  const openCommentComposer = (postId: string, reply?: MomentsComment) => {
    setActiveCommentPostId(postId);
    setReplyingTo(reply || null);
    setCommentDraft('');
  };

  const submitComment = async () => {
    const postId = activeCommentPostId;
    const content = commentDraft.trim();
    if (!postId || !content) return;
    setBusy(true);
    try {
      const comment: MomentsComment = {
        id: `moment-comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        postId, actorId: USER_PROFILE_ID, actorType: 'user', actorName: profile.displayName, actorAvatar: profile.avatar,
        content, replyToCommentId: replyingTo?.id, replyToActorId: replyingTo?.actorId, createdAt: Date.now(), source: 'manual',
      };
      await DB.saveMomentsComment(comment);
      const post = posts.find(item => item.id === postId);
      if (post) await recordMomentsEvent({ postId, actorId: USER_PROFILE_ID, type: replyingTo ? 'reply' : 'comment', sourceId: comment.id, visibleToActorIds: visibleActorIdsForPost(post.visibility), createdAt: comment.createdAt });
      if (post) void reportMomentsJealousy({
        post, sourceId: comment.id, content,
        kind: 'moments_intimate_comment',
        directActorId: replyingTo?.actorId || (post.authorType === 'character' ? post.authorId : undefined),
      });
      void flushMomentsWorker();
      setCommentsByPost(prev => ({ ...prev, [postId]: [...(prev[postId] || []), comment] }));
      setActiveCommentPostId(null);
      setReplyingTo(null);
      setCommentDraft('');
      if (post) queuePostInteractionReplan(post, comment);
    } catch (error: any) { addToast(error?.message || '评论发送失败', 'error'); }
    finally { setBusy(false); }
  };

  const confirmDeleteComment = async () => {
    const target = deleteCommentTarget;
    if (!target) return;
    setBusy(true);
    try {
      const postComments = await DB.getMomentsCommentsByPostId(target.postId);
      const deletedIds = new Set([target.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const comment of postComments) {
          if (comment.replyToCommentId && deletedIds.has(comment.replyToCommentId) && !deletedIds.has(comment.id)) {
            deletedIds.add(comment.id);
            grew = true;
          }
        }
      }
      const memoryIndexes = (await DB.getMomentsMemoryIndexesByPostId(target.postId)).filter(item => deletedIds.has(item.sourceId));
      await removeMomentsSourcesFromMemoryPalace(target.postId, [...deletedIds], memoryIndexes.map(item => item.memoryNodeId).filter((id): id is string => Boolean(id)));
      await DB.deleteMomentsCommentsCascade(target.postId, [...deletedIds]);
      const post = posts.find(item => item.id === target.postId);
      if (post) {
        for (const id of deletedIds) await recordMomentsEvent({ postId: target.postId, actorId: USER_PROFILE_ID, type: 'delete', sourceId: `moment-delete-comment-${id}`, deletedSourceId: id, visibleToActorIds: [], createdAt: Date.now() });
      }
      setCommentsByPost(prev => ({ ...prev, [target.postId]: (prev[target.postId] || []).filter(comment => !deletedIds.has(comment.id)) }));
      setPendingJobs(await DB.getMomentsPendingJobs());
      setDeleteCommentTarget(null);
      void flushMomentsWorker();
      addToast(deletedIds.size > 1 ? `评论及 ${deletedIds.size - 1} 条关联回复已删除，相关记忆已撤销` : '评论已删除，相关记忆已撤销', 'success');
    } catch (error: any) { addToast(error?.message || '删除评论失败', 'error'); }
    finally { setBusy(false); }
  };

  const startCommentLongPress = (comment: MomentsComment) => {
    commentLongPressTriggered.current = false;
    commentLongPressTimer.current = window.setTimeout(() => {
      commentLongPressTriggered.current = true;
      setDeleteCommentTarget(comment);
    }, 650);
  };

  const cancelCommentLongPress = () => {
    if (commentLongPressTimer.current !== null) window.clearTimeout(commentLongPressTimer.current);
    commentLongPressTimer.current = null;
  };

  const isPostVisibleTo = (post: MomentsPost, actorId: string) => {
    // 精简 NPC 不拥有绕过分组的独立权限；其浏览资格跟随人设来源角色。
    const npc = npcProfiles.find(profile => profile.id === actorId);
    const effectiveActorId = npc?.parentCharacterId ? `moments:character:${npc.parentCharacterId}` : actorId;
    if (post.visibility.mode === 'private') return actorId === USER_PROFILE_ID;
    if (post.visibility.mode === 'partial') return post.visibility.allowedActorIds.includes(effectiveActorId);
    if (post.visibility.mode === 'exclude') return !post.visibility.blockedActorIds.includes(effectiveActorId);
    return true;
  };

  const forwardPostToCharacter = async (post: MomentsPost, friend: MomentsProfile) => {
    if (!friend.characterId) return;
    setBusy(true);
    try {
      const allowed = isPostVisibleTo(post, friend.id);
      const shareId = `moment-share-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const media = mediaByPost[post.id] || [];
      const body = post.content || (media.length ? '分享了一张照片' : '分享了一条朋友圈');
      const html = `<div style="width:272px;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #e9e9e9;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#1f2937"><div style="padding:13px 14px 10px;background:linear-gradient(135deg,#edf6ff,#f8fbff);color:#576b95;font-size:11px;letter-spacing:.08em">朋友圈 · 转发给你</div><div style="padding:14px"><div style="font-size:14px;font-weight:700;color:#334155">${escapeHtml(post.authorName)} 的朋友圈</div><div style="margin-top:8px;font-size:13px;line-height:1.55;white-space:pre-wrap;color:#334155">${escapeHtml(body)}</div>${media[0] ? `<div style="margin-top:10px;font-size:11px;color:#8a94a6">含 ${media.length} 张图片 · 打开朋友圈查看</div>` : ''}</div><div style="padding:9px 14px;border-top:1px solid #f0f0f0;color:#98a2b3;font-size:10px">${allowed ? '这条动态对你原本可见' : '这是仅供你阅读的转发快照'}</div></div>`;
      await Promise.all([
        DB.saveMomentsShare({ id: shareId, postId: post.id, fromActorId: USER_PROFILE_ID, toActorId: friend.id, visibilityAtShare: allowed ? 'allowed' : 'screened_out', snapshotText: body, snapshotMediaUrl: media[0]?.url, createdAt: Date.now(), deliveredAt: Date.now() }),
        DB.saveMomentsSeenReceipt({ id: `moment-seen-${post.id}-${friend.id}`, postId: post.id, actorId: friend.id, state: allowed ? 'delivered' : 'screened_out', reason: allowed ? 'manual-forward-visible' : 'manual-forward-snapshot-only', createdAt: Date.now(), updatedAt: Date.now() }),
        DB.saveMessage({ charId: friend.characterId, role: 'user', type: 'html_card', content: `[朋友圈转发] ${body}`, metadata: { htmlSource: html, momentsShareId: shareId, momentsPostId: post.id, momentsVisibilityAtShare: allowed ? 'allowed' : 'screened_out' } }),
      ]);
      await recordMomentsEvent({ postId: post.id, actorId: USER_PROFILE_ID, type: 'share', sourceId: shareId, visibleToActorIds: [friend.id], createdAt: Date.now() });
      await recordMomentsEvent({ postId: post.id, actorId: friend.id, type: 'seen', sourceId: `${shareId}:seen:${friend.id}`, visibleToActorIds: [friend.id], createdAt: Date.now() });
      setShareTargetPost(null);
      addToast(`已转发给 ${friend.displayName}`, 'success');
    } catch (error: any) { addToast(error?.message || '转发失败，请稍后重试', 'error'); }
    finally { setBusy(false); }
  };

  const shakeStranger = async () => {
    if (strangerBusy) return;
    setStrangerBusy(true);
    const attractive = Math.random() < 0.8;
    try {
      const local = createLocalRandomStranger(attractive);
      let { name, bio: persona, openingLine } = local;
      const config = settings.momentsApi || momentsApiFromMain(apiConfig);
      if (isMomentsApiReady(config)) {
        try {
          const generated = await planMomentsStranger({ config, attractive, now: Date.now(), diversitySeed: `${crypto.randomUUID?.() || Math.random()}-${Date.now()}` });
          name = generated.name; persona = generated.bio; openingLine = generated.openingLine;
        } catch {
          // 浏览器直连失败时仍用组合式随机档案，不退回固定的几个人。
        }
      }
      const now = Date.now();
      const id = `stranger-${now}-${Math.random().toString(36).slice(2, 8)}`;
      const profileId = `moments:stranger:${id}`;
      const profile: MomentsProfile = { id: profileId, actorType: 'stranger', displayName: name, cover: defaultCover, bio: persona, friendshipState: 'temporary', updatedAt: now };
      const record: MomentsTempStranger = { id, profileId, createdAt: now, lastMetAt: now, canViewLatestTen: settings.strangersCanViewTen, generatorSeed: `${attractive ? 'bright' : 'rough'}-${now}`, persona };
      const greeting: MomentsTempTranscript = { id: `stranger-opening-${id}`, strangerId: id, sender: 'stranger', content: openingLine, createdAt: now };
      await Promise.all([DB.saveMomentsProfile(profile), DB.saveMomentsTempStranger(record), DB.saveMomentsTempTranscript(greeting)]);
      setTempStrangers(prev => [record, ...prev.filter(item => item.id !== record.id)]);
      setActiveStranger(profile);
      setStrangerTranscript([greeting]);
      setStrangerDraft('');
    } catch (error: any) {
      addToast(error?.message || '摇一摇失败，请稍后重试', 'error');
    } finally { setStrangerBusy(false); }
  };

  const openSavedStranger = async (stranger: MomentsTempStranger) => {
    const profile = await DB.getMomentsProfile(stranger.profileId);
    if (!profile) return;
    setActiveStranger(profile);
    setStrangerTranscript(await DB.getMomentsTempTranscripts(stranger.id));
    setStrangerDraft('');
  };

  const queueStrangerMessage = async () => {
    const stranger = tempStrangers.find(item => item.profileId === activeStranger?.id);
    const content = strangerDraft.trim();
    if (!stranger || !content || strangerBusy) return;
    const now = Date.now();
    const userLine: MomentsTempTranscript = { id: `stranger-msg-${now}-${Math.random().toString(36).slice(2, 7)}`, strangerId: stranger.id, sender: 'user', content, createdAt: now };
    try {
      await DB.saveMomentsTempTranscript(userLine);
      setStrangerTranscript(prev => [...prev, userLine]);
      setStrangerDraft('');
    } catch (error: any) { addToast(error?.message || '消息保存失败', 'error'); }
  };

  const requestStrangerReply = async () => {
    const stranger = tempStrangers.find(item => item.profileId === activeStranger?.id);
    if (!stranger || !activeStranger || strangerBusy) return;
    const latestTranscript = await DB.getMomentsTempTranscripts(stranger.id);
    if (!latestTranscript.length || latestTranscript.at(-1)?.sender !== 'user') {
      addToast('先把想说的话发送出去，再点右上角小飞机让对方回复', 'info');
      return;
    }
    const config = settings.momentsApi || momentsApiFromMain(apiConfig);
    if (!isMomentsApiReady(config)) {
      addToast('请先在朋友圈设置中配置可用的副 API', 'error');
      return;
    }
    setStrangerBusy(true);
    const now = Date.now();
    try {
      const replyContent = await replyMomentsStranger({
        config,
        profile: activeStranger,
        transcript: latestTranscript.map(item => ({ sender: item.sender, content: item.content, createdAt: item.createdAt })),
        now,
      });
      const reply: MomentsTempTranscript = { id: `stranger-msg-${now + 1}-${Math.random().toString(36).slice(2, 7)}`, strangerId: stranger.id, sender: 'stranger', content: replyContent, createdAt: now + 1 };
      await Promise.all([DB.saveMomentsTempTranscript(reply), DB.saveMomentsTempStranger({ ...stranger, lastMetAt: now })]);
      setStrangerTranscript(prev => [...prev, reply]);
      setTempStrangers(prev => prev.map(item => item.id === stranger.id ? { ...item, lastMetAt: now } : item));
    } catch (error: any) {
      addToast(error?.message || '对方暂时没有回复，已发送的消息仍然保留', 'error');
    } finally { setStrangerBusy(false); }
  };

  const deleteTemporaryStranger = async () => {
    const stranger = strangerDeleteTarget;
    if (!stranger) return;
    setStrangerBusy(true);
    try {
      await DB.deleteMomentsTempStrangerData(stranger.id, stranger.profileId);
      setTempStrangers(prev => prev.filter(item => item.id !== stranger.id));
      if (activeStranger?.id === stranger.profileId) {
        setActiveStranger(null);
        setStrangerTranscript([]);
        setStrangerDraft('');
      }
      setStrangerDeleteTarget(null);
      addToast('已删除这位临时陌生人和临时聊天记录', 'success');
    } catch (error: any) {
      addToast(error?.message || '删除失败，请稍后重试', 'error');
    } finally { setStrangerBusy(false); }
  };

  const addStrangerAsFriend = async () => {
    const stranger = tempStrangers.find(item => item.profileId === activeStranger?.id);
    if (!stranger || !activeStranger) return;
    const promotionKey = `stranger:${stranger.id}`;
    if (friendPromotionInFlight.current.has(promotionKey)) {
      addToast('正在添加，请不要重复点击', 'info');
      return;
    }
    const sameName = normalizedPersonName(activeStranger.displayName);
    const existingCharacter = characters.find(character => normalizedPersonName(character.name) === sameName);
    if (stranger.formalCharacterId || existingCharacter) {
      addToast(`${activeStranger.displayName} 已经是角色好友，不会重复生成人设`, 'info');
      return;
    }
    friendPromotionInFlight.current.add(promotionKey);
    setStrangerBusy(true);
    try {
      const transcripts = await DB.getMomentsTempTranscripts(stranger.id);
      const card = await planMomentsStrangerCharacterProfile({
        config: settings.momentsApi || momentsApiFromMain(apiConfig),
        profile: activeStranger,
        transcript: transcripts.map(item => ({ sender: item.sender, content: item.content })),
      });
      const created = await addCharacter();
      const transcriptSummary = transcripts.map(item => `${item.sender === 'user' ? userProfile.name : activeStranger.displayName}：${item.content}`).join('\n');
      const memory: MemoryFragment = { id: `moments-stranger-memory-${stranger.id}`, date: new Date().toISOString().slice(0, 10), summary: `通过朋友圈摇一摇认识了${activeStranger.displayName}。临时聊天记录：\n${transcriptSummary || '尚未聊天。'}`, mood: 'archive' };
      await updateCharacter(created.id, { name: activeStranger.displayName, description: card.description, systemPrompt: card.systemPrompt, memories: [...(created.memories || []), memory] });
      const now = Date.now();
      await Promise.all([
        DB.saveMomentsProfile({ ...activeStranger, id: `moments:character:${created.id}`, characterId: created.id, friendshipState: 'friend', updatedAt: now }),
        DB.saveMomentsTempStranger({ ...stranger, addedAsFriendAt: now, formalCharacterId: created.id, lastMetAt: now }),
        ...transcripts.map(item => DB.saveMomentsTempTranscript({ ...item, migratedAt: now })),
        ...transcripts.map(item => DB.saveMomentsMemoryIndex({ id: `moments-temp-memory-${item.id}-${created.id}`, actorId: created.id, sourceId: item.id, createdAt: item.createdAt })),
      ]);
      setActiveStranger(null);
      setTempStrangers(prev => prev.filter(item => item.id !== stranger.id));
      addToast(`${activeStranger.displayName} 已添加为角色好友，临时聊天已迁移到记忆`, 'success');
    } catch (error: any) { addToast(error?.message || '添加好友失败', 'error'); }
    finally { friendPromotionInFlight.current.delete(promotionKey); setStrangerBusy(false); }
  };

  const saveMomentsApi = async () => {
    const next = {
      ...momentsApiDraft,
      baseUrl: momentsApiDraft.baseUrl.trim().replace(/\/+$/, ''),
      apiKey: momentsApiDraft.apiKey.trim(),
      model: momentsApiDraft.model.trim(),
      enabled: true,
    };
    if (!isMomentsApiReady(next)) { setMomentsApiStatus('请填写完整的 URL、Key 和 Model'); return; }
    await saveMomentsSettingsPatch({ momentsApi: next });
    setMomentsApiDraft(next);
    setMomentsApiStatus('朋友圈副 API 已保存');
  };

  const loadMomentsModels = async () => {
    if (!momentsApiDraft.baseUrl.trim() || !momentsApiDraft.apiKey.trim()) { setMomentsApiStatus('请先填写 URL 和 Key'); return; }
    setMomentsApiBusy('models'); setMomentsApiStatus('正在拉取朋友圈副 API 模型…');
    try {
      const models = await fetchMomentsModels(momentsApiDraft);
      setMomentsApiModels(models);
      if (!models.includes(momentsApiDraft.model)) setMomentsApiDraft(prev => ({ ...prev, model: models[0] }));
      setMomentsApiStatus(`已拉取 ${models.length} 个模型`);
    } catch (error: any) { setMomentsApiStatus(`拉取失败：${error?.message || '网络或跨域错误'}`); }
    finally { setMomentsApiBusy(null); }
  };

  const testMomentsConnection = async () => {
    setMomentsApiBusy('test'); setMomentsApiStatus('正在测试朋友圈副 API…');
    try { await testMomentsApi(momentsApiDraft); setMomentsApiStatus('✅ 连接成功（只验证 /models，不消耗生成额度）'); }
    catch (error: any) { setMomentsApiStatus(`❌ 连接失败：${error?.message || '网络或跨域错误'}`); }
    finally { setMomentsApiBusy(null); }
  };

  const visiblePosts = view === 'profile' ? posts.filter(post => post.authorId === timelineProfile.id) : posts;
  const profileForPostAuthor = (post: MomentsPost) => post.authorId === USER_PROFILE_ID ? profile : friends.find(friend => friend.id === post.authorId) || npcProfiles.find(npc => npc.id === post.authorId) || timelineProfile;
  const headerTitle = view === 'profile' ? timelineProfile.displayName : view === 'messages' ? '消息' : view === 'settings' ? '朋友圈设置' : '朋友圈';
  const displayProfile = view === 'profile' ? timelineProfile : profile;
  const isOwnTimeline = displayProfile.id === USER_PROFILE_ID;
  const selectedAudienceCount = unique([
    ...draftAudience,
    ...characters.filter(character => character.groupId && draftGroupIds.includes(character.groupId)).map(character => `moments:character:${character.id}`),
    ...(settings.visibilityGroups || []).filter(group => draftGroupIds.includes(group.id)).flatMap(group => group.actorIds),
  ]).length;
  const interactionActorName = (post: MomentsPost, actorId?: string) => {
    if (!actorId) return '对方';
    if (actorId === USER_PROFILE_ID) return profile.displayName || '我';
    if (post.authorId === actorId) return post.authorName;
    return friends.find(actor => actor.id === actorId)?.displayName
      || npcProfiles.find(actor => actor.id === actorId)?.displayName
      || randomPasserbyActorsForPost(post.id).find(actor => actor.id === actorId)?.displayName
      || '对方';
  };
  const socialInbox = useMemo(() => posts.flatMap(post => {
    const target = post.authorId === USER_PROFILE_ID ? '你的动态' : `${post.authorName}的动态`;
    return [
    ...(reactionsByPost[post.id] || []).filter(reaction => reaction.actorId !== USER_PROFILE_ID).map(reaction => ({ id: `reaction-${reaction.id}`, type: 'reaction' as const, postId: post.id, actorName: reaction.actorName, kind: `赞了${target}`, createdAt: reaction.createdAt })),
    ...(commentsByPost[post.id] || []).filter(comment => comment.actorId !== USER_PROFILE_ID).map(comment => ({ id: `comment-${comment.id}`, type: 'comment' as const, postId: post.id, actorName: comment.actorName, kind: `${comment.replyToActorId ? `回复了 ${interactionActorName(post, comment.replyToActorId)}` : `评论了${target}`}：${comment.content}`, createdAt: comment.createdAt })),
    ];
  }).sort((a, b) => b.createdAt - a.createdAt), [commentsByPost, posts, reactionsByPost]);
  const unreadSocialCount = socialInbox.filter(item => item.createdAt > (settings.lastInboxReadAt || 0)).length;
  const markSocialInboxRead = useCallback(() => {
    if (!socialInbox.length) return;
    void saveMomentsSettingsPatch({ lastInboxReadAt: Date.now() });
  }, [saveMomentsSettingsPatch, socialInbox.length]);
  const strangerVisiblePosts = settings.strangersCanViewTen
    ? posts.filter(post => post.authorId === USER_PROFILE_ID && post.visibility.mode === 'public').sort((a, b) => b.createdAt - a.createdAt).slice(0, 10)
    : [];
  const hasUnansweredStrangerMessages = strangerTranscript.at(-1)?.sender === 'user';

  return (
    <div className="sully-moments-root relative flex h-full min-h-0 flex-col overflow-hidden bg-[#f7f7f7] text-[#181818]">
      <style>{`.sully-moments-root > .absolute.inset-0.flex.flex-col{padding-top:var(--chrome-top,var(--safe-top,0px))}.sully-moments-root > .absolute.inset-0.flex.flex-col > header button{min-width:44px;min-height:44px;touch-action:manipulation}`}</style>
      {(view === 'settings' || view === 'messages') && <header className="relative z-40 shrink-0 border-b border-black/[0.05] bg-[#f7f7f7]" style={{ paddingTop: 'var(--chrome-top, var(--safe-top, 0px))' }}>
        <div className="flex h-[54px] items-center justify-between px-2.5">
          <button type="button" onClick={() => setView('feed')} className="flex h-11 w-11 touch-manipulation items-center justify-center rounded-full active:bg-black/[0.06]" aria-label="返回朋友圈"><ArrowLeft size={26} /></button>
          <div className="text-[17px] font-semibold tracking-[0.02em]">{headerTitle}</div>
          <div className="h-11 w-11" />
        </div>
      </header>}

      {view === 'settings' ? (
        <div className="flex-1 overflow-y-auto px-4 py-5">
          <section className="overflow-hidden rounded-2xl bg-white shadow-[0_1px_5px_rgba(0,0,0,0.05)]">
            <div className="px-4 py-4 text-[14px] font-semibold">朋友圈副 API</div>
            <div className="space-y-3 border-t border-[#ededed] px-4 py-4">
              <p className="text-[11px] leading-relaxed text-[#888]">用于角色发帖与首轮互动规划。每条动态只调用一次，后续按已保存计划错峰执行；图片仍走现有生图 API。</p>
              <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                <button type="button" onClick={() => setMomentsApiDraft(momentsApiFromMain(apiConfig))} className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] ${momentsApiDraft.source === 'main' ? 'bg-[#07c160] text-white' : 'bg-[#f1f1f1] text-[#666]'}`}>跟随主 API</button>
                {apiPresets.map(preset => <button type="button" key={preset.id} onClick={() => setMomentsApiDraft(momentsApiFromPreset(preset))} className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] ${momentsApiDraft.source === 'preset' && momentsApiDraft.presetId === preset.id ? 'bg-[#07c160] text-white' : 'bg-[#f1f1f1] text-[#666]'}`}>{preset.name}</button>)}
                <button type="button" onClick={() => setMomentsApiDraft(prev => ({ ...prev, source: 'custom', presetId: undefined }))} className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] ${momentsApiDraft.source === 'custom' ? 'bg-[#07c160] text-white' : 'bg-[#f1f1f1] text-[#666]'}`}>自定义</button>
              </div>
              <input value={momentsApiDraft.baseUrl} onChange={event => setMomentsApiDraft(prev => ({ ...prev, source: 'custom', presetId: undefined, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" className="w-full rounded-xl border border-[#e6e6e6] bg-[#fafafa] px-3 py-2.5 text-[12px] font-mono outline-none focus:bg-white" />
              <input type="password" autoComplete="new-password" value={momentsApiDraft.apiKey} onChange={event => setMomentsApiDraft(prev => ({ ...prev, source: 'custom', presetId: undefined, apiKey: event.target.value }))} placeholder="API Key" className="w-full rounded-xl border border-[#e6e6e6] bg-[#fafafa] px-3 py-2.5 text-[12px] font-mono outline-none focus:bg-white" />
              <div className="flex gap-2">
                {momentsApiModels.length > 0 ? <select value={momentsApiDraft.model} onChange={event => setMomentsApiDraft(prev => ({ ...prev, model: event.target.value }))} className="min-w-0 flex-1 rounded-xl border border-[#e6e6e6] bg-[#fafafa] px-3 py-2.5 text-[12px]"><option value="">选择模型</option>{momentsApiModels.map(model => <option key={model} value={model}>{model}</option>)}</select> : <input value={momentsApiDraft.model} onChange={event => setMomentsApiDraft(prev => ({ ...prev, model: event.target.value }))} placeholder="朋友圈文本模型" className="min-w-0 flex-1 rounded-xl border border-[#e6e6e6] bg-[#fafafa] px-3 py-2.5 text-[12px]" />}
                <button type="button" onClick={() => void loadMomentsModels()} disabled={momentsApiBusy === 'models'} className="shrink-0 rounded-xl bg-[#e8f7ee] px-3 text-[11px] font-medium text-[#07a34a] disabled:opacity-50">{momentsApiBusy === 'models' ? '拉取中…' : '拉取模型'}</button>
              </div>
              <div className="flex gap-2"><button type="button" onClick={() => void testMomentsConnection()} disabled={momentsApiBusy === 'test'} className="flex-1 rounded-xl border border-[#d6eadc] py-2.5 text-[12px] font-medium text-[#078b43] disabled:opacity-50">{momentsApiBusy === 'test' ? '测试中…' : '测试连接'}</button><button type="button" onClick={() => void saveMomentsApi()} className="flex-1 rounded-xl bg-[#07c160] py-2.5 text-[12px] font-medium text-white">保存副 API</button></div>
              {momentsApiStatus && <div className={`rounded-xl px-3 py-2 text-[11px] leading-relaxed ${/失败|错误/.test(momentsApiStatus) ? 'bg-[#fff1f1] text-[#d95757]' : 'bg-[#effaf2] text-[#168446]'}`}>{momentsApiStatus}</div>}
            </div>
          </section>

          <section className="mt-4 overflow-hidden rounded-2xl bg-white shadow-[0_1px_5px_rgba(0,0,0,0.05)]">
            <div className="px-4 py-4 text-[14px] font-semibold">复用主动消息 2.0 Worker</div>
            <div className="space-y-3 border-t border-[#ededed] px-4 py-4">
              <p className="text-[11px] leading-relaxed text-[#888]">朋友圈不再单独填写 Worker。它会复用系统设置「主动消息 2.0」里的同一个地址、用户 ID、共享密钥和 D1；朋友圈只新增独立的 <span className="font-mono">/moments/*</span> 路由，原版主动消息任务和生成流程不变。</p>
              <div className="rounded-xl bg-[#f7f8fb] px-3 py-2.5 text-[11px] leading-relaxed text-[#61708a]">
                <div>Worker 地址：<span className="font-mono break-all">{sharedAmsgWorker?.url || '尚未在主动消息 2.0 中配置'}</span></div>
                <div className="mt-1">用户 ID：{sharedAmsgWorker?.userId || '未读取'}</div>
                <div className="mt-1">共享密钥：{sharedAmsgWorker?.clientToken ? '已读取（不会在此处显示）' : '未设置'}</div>
              </div>
              <div className="flex gap-2"><button type="button" onClick={() => void refreshAmsgWorker()} className="flex-1 rounded-xl bg-[#576b95] py-2.5 text-[12px] font-medium text-white">重新读取配置</button><button type="button" onClick={() => void flushMomentsWorker()} disabled={momentsApiBusy === 'sync' || !sharedAmsgWorker} className="flex-1 rounded-xl border border-[#dfe3ee] py-2.5 text-[12px] font-medium text-[#576b95] disabled:opacity-50">{momentsApiBusy === 'sync' ? '同步中…' : '立即重试同步'}</button></div>
              <button type="button" onClick={() => void refreshMomentsWorkerDiagnostics()} disabled={!sharedAmsgWorker} className="w-full rounded-xl border border-[#dfe3ee] py-2.5 text-[12px] font-medium text-[#576b95] disabled:opacity-50">读取 Worker 任务诊断</button>
              <div className="text-[11px] text-[#999]">同步状态：{settings.syncStatus === 'synced' ? `已同步${settings.lastSyncAt ? ` · ${formatMomentTime(settings.lastSyncAt)}` : ''}` : settings.syncStatus === 'failed' ? `失败 · ${settings.syncError || '未知错误'}` : '本机队列待同步'}</div>
              {workerDiagnostics && <div className="rounded-xl bg-[#f7f8fb] px-3 py-2.5 text-[11px] leading-relaxed text-[#61708a]">
                <div className="font-medium text-[#16945c]">Worker / D1 当前可读</div>
                <div className="mt-1">云端任务：待执行 {workerDiagnostics.counts.pending || 0} · 执行中 {workerDiagnostics.counts.running || 0} · 已完成 {workerDiagnostics.counts.done || 0} · 失败 {workerDiagnostics.counts.failed || 0}</div>
                {workerDiagnostics.recent[0] && <div className="mt-1 break-words">最近一条历史诊断（发生于 {formatMomentTime(workerDiagnostics.recent[0].createdAt)}）：{workerDiagnostics.recent[0].message}</div>}
                <div className="mt-1 text-[#99a2b3]">本次成功读取于 {formatMomentTime(workerDiagnostics.checkedAt)}</div>
              </div>}
            </div>
          </section>

          <section className="mt-4 overflow-hidden rounded-2xl bg-white shadow-[0_1px_5px_rgba(0,0,0,0.05)]">
            <button type="button" onClick={() => void saveMomentsSettingsPatch({ offlineSyncEnabled: !settings.offlineSyncEnabled })} className="flex w-full items-center gap-3 px-4 py-4 text-left">
              <ArrowsClockwise size={21} className="text-[#576b95]" />
              <span className="flex-1"><span className="block text-[14px]">关闭小手机后继续生活线</span><span className="mt-1 block text-[11px] leading-relaxed text-[#888]">复用主动消息 2.0 的加密凭据与同一 Worker；关闭页面后仍每 15 分钟错峰检查一位到期角色。真正发帖时云端生成全新正文，并用一次统一规划安排后续点赞、评论和回复。</span></span>
              <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${settings.offlineSyncEnabled ? 'bg-[#07c160]' : 'bg-[#d7d7d7]'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${settings.offlineSyncEnabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`} /></span>
            </button>
          </section>

          <section className="mt-4 overflow-hidden rounded-2xl bg-white shadow-[0_1px_5px_rgba(0,0,0,0.05)]">
            <button type="button" onClick={() => {
              const next = !settings.jealousyForceEnabled;
              void saveMomentsSettingsPatch({ jealousyForceEnabled: next });
              void setRelationshipJealousyForceEnabled(characters, next).catch((error: any) => addToast(`醋意开关暂未同步到 Worker：${error?.message || '网络错误'}`, 'error'));
            }} className="flex w-full items-center gap-3 px-4 py-4 text-left">
              <Heart size={21} className="text-[#e7728b]" weight="fill" />
              <span className="flex-1"><span className="block text-[14px]">醋意强制联系</span><span className="mt-1 block text-[11px] leading-relaxed text-[#888]">角色实际看见暧昧动态或亲密评论后，醋意达到 80 会优先建立一条原版主动消息 2.0 联系机会。关闭后仍记录、展示醋意，但不强制联系。</span></span>
              <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${settings.jealousyForceEnabled ? 'bg-[#e7728b]' : 'bg-[#d7d7d7]'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${settings.jealousyForceEnabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`} /></span>
            </button>
          </section>

          <section className="overflow-hidden rounded-2xl bg-white shadow-[0_1px_5px_rgba(0,0,0,0.05)]">
            <div className="px-4 py-4 text-[14px] font-semibold">隐私</div>
            <button type="button" onClick={() => void setStrangerVisibility(!settings.strangersCanViewTen)} className="flex w-full items-center gap-3 border-t border-[#ededed] px-4 py-4 text-left">
              <UsersThree size={21} className="text-[#576b95]" />
              <span className="flex-1 text-[14px]">允许陌生人查看十条朋友圈</span>
              <span className={`relative h-6 w-11 rounded-full transition-colors ${settings.strangersCanViewTen ? 'bg-[#07c160]' : 'bg-[#d7d7d7]'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${settings.strangersCanViewTen ? 'translate-x-[22px]' : 'translate-x-0.5'}`} /></span>
            </button>
            <p className="border-t border-[#ededed] px-4 py-3 text-[11px] leading-relaxed text-[#888]">开启后，摇一摇遇到、但尚未添加的陌生人只可浏览你最近十条公开动态；他们不能点赞、评论或回复。</p>
          </section>
          <section className="mt-4 overflow-hidden rounded-2xl bg-white shadow-[0_1px_5px_rgba(0,0,0,0.05)]"><div className="px-4 py-4 text-[14px] font-semibold">角色发帖与互动</div><p className="border-t border-[#ededed] px-4 py-3 text-[11px] leading-relaxed text-[#888]">低频约每周 2–4 条，中频每天约一次，高频每天最多三段机会；日程当前显示睡眠时不自主发帖。发帖和互动单独控制。</p>{characters.length === 0 ? <div className="border-t border-[#ededed] px-4 py-4 text-[13px] text-[#999]">还没有已添加的角色。</div> : characters.map(character => <div key={character.id} className="border-t border-[#ededed] px-4 py-3"><div className="mb-2 text-[14px] text-[#333]">{character.name}</div><div className="mb-2 text-[11px] text-[#999]">发帖频率</div><div className="flex gap-1 overflow-x-auto pb-0.5">{([['off', '关闭'], ['low', '低'], ['medium', '中'], ['high', '高'], ['view_only', '只看不发']] as const).map(([mode, label]) => <button type="button" key={mode} onClick={() => void setCharacterPostingMode(character.id, mode)} className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] ${((settings.characterPostingModes || {})[character.id] || 'off') === mode ? 'bg-[#07c160] text-white' : 'bg-[#f1f1f1] text-[#666]'}`}>{label}</button>)}</div><div className="mb-2 mt-3 text-[11px] text-[#999]">互动方式</div><div className="flex gap-1 overflow-x-auto pb-0.5">{([['normal', '正常互动'], ['reaction_only', '只点赞'], ['off', '不自动互动']] as const).map(([mode, label]) => <button type="button" key={mode} onClick={() => void setCharacterInteractionMode(character.id, mode)} className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] ${((settings.characterInteractionModes || {})[character.id] || 'normal') === mode ? 'bg-[#576b95] text-white' : 'bg-[#f1f1f1] text-[#666]'}`}>{label}</button>)}</div></div>)}</section>
          <section className="mt-4 overflow-hidden rounded-2xl bg-white shadow-[0_1px_5px_rgba(0,0,0,0.05)]">
            <div className="px-4 py-4 text-[14px] font-semibold">人设中的明确 NPC</div>
            <div className="border-t border-[#ededed] px-4 py-3">
              <p className="text-[11px] leading-relaxed text-[#888]">只提取角色人设里有姓名或稳定身份关系的 NPC；不会把一次性路人变成角色，也没有临时私聊。同步后默认低频持续发朋友圈，可在下方单独调整。</p>
              <button type="button" disabled={momentsApiBusy === 'sync'} onClick={() => void syncExplicitNpcs()} className="mt-3 w-full rounded-xl bg-[#edf6ff] py-2.5 text-[12px] font-medium text-[#576b95] disabled:opacity-50">{momentsApiBusy === 'sync' ? '同步中…' : `从角色人设同步 NPC${npcProfiles.length ? `（当前 ${npcProfiles.length} 位）` : ''}`}</button>
            </div>
            {npcProfiles.map(npc => <div key={npc.id} className="border-t border-[#ededed] px-4 py-3">
              <div className="mb-1 text-[14px] text-[#333]">{npc.displayName}<span className="ml-1.5 text-[11px] text-[#999]">{npc.relationLabel || '明确 NPC'}</span></div>
              <div className="mb-2 text-[11px] text-[#999]">持续发帖频率</div>
              <div className="flex gap-1 overflow-x-auto pb-0.5">{([['off', '关闭'], ['low', '低'], ['medium', '中'], ['high', '高'], ['view_only', '只看不发']] as const).map(([mode, label]) => <button type="button" key={mode} onClick={() => void setNpcPostingMode(npc.id, mode)} className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] ${((settings.npcPostingModes || {})[npc.id] || 'low') === mode ? 'bg-[#07c160] text-white' : 'bg-[#f1f1f1] text-[#666]'}`}>{label}</button>)}</div>
            </div>)}
          </section>
          <section className="mt-4 overflow-hidden rounded-2xl bg-white shadow-[0_1px_5px_rgba(0,0,0,0.05)]">
            <div className="px-4 py-4 text-[14px] font-semibold">自动行为</div>
            <button type="button" onClick={() => void saveMomentsSettingsPatch({ autoInteractionEnabled: !settings.autoInteractionEnabled })} className="flex w-full items-center gap-3 border-t border-[#ededed] px-4 py-4 text-left"><span className="flex-1 text-[14px]">自动点赞与评论</span><span className={`relative h-6 w-11 rounded-full transition-colors ${settings.autoInteractionEnabled ? 'bg-[#07c160]' : 'bg-[#d7d7d7]'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${settings.autoInteractionEnabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`} /></span></button>
            <p className="border-t border-[#ededed] px-4 py-3 text-[11px] leading-relaxed text-[#888]">打开后，发表动态会先用副 API 生成一份完整互动计划，之后按时间错峰执行，不会按角色数量重复调用。</p>
          </section>
          <div className="mt-4 rounded-2xl bg-[#fff1f5] px-4 py-3 text-[11px] leading-relaxed text-[#9b5d70]">朋友圈关系层已启用：只有实际刷到或被直接回复的角色会接收结构化醋意事实；醋意达到 80 时可由下方开关决定是否建立一条高优先级原版主动消息 2.0 联系机会。</div>
        </div>
      ) : view === 'messages' ? (
        socialInbox.length === 0 ? <div className="flex flex-1 flex-col items-center justify-center px-10 text-center text-[#999]">
          <div className="mb-3 text-4xl">💬</div>
          <div className="text-[14px] text-[#555]">还没有朋友圈消息</div>
          <p className="mt-2 text-[12px] leading-relaxed">角色和 NPC 的点赞、评论与回复会显示在这里，不会自动塞进你的私聊。</p>
        </div> : <div className="flex-1 overflow-y-auto bg-white">{socialInbox.map(item => <button type="button" key={item.id} onClick={() => { markSocialInboxRead(); const post = posts.find(candidate => candidate.id === item.postId); if (post) { setTimelineProfile(profileForPostAuthor(post)); setView('profile'); } }} className="flex w-full gap-3 border-b border-[#ededed] px-4 py-4 text-left"><div className={`flex h-10 w-10 items-center justify-center rounded ${item.type === 'reaction' ? 'bg-[#fff0f2] text-[#e45b70]' : 'bg-[#edf5ff] text-[#576b95]'}`}>{item.type === 'reaction' ? <Heart size={22} weight="fill" /> : <ChatCircleText size={22} weight="fill" />}</div><div className="min-w-0 flex-1"><div className="text-[13px] text-[#576b95]">{item.actorName}</div><div className="mt-1 truncate text-[13px] text-[#555]">{item.kind}</div><div className="mt-1 text-[11px] text-[#999]">{formatMomentTime(item.createdAt)}</div></div></button>)}</div>
      ) : (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex items-center justify-between px-2.5" style={{ paddingTop: 'calc(var(--chrome-top, var(--safe-top, 0px)) + 8px)' }}>
            <div className="flex items-center gap-1">
              <button type="button" onClick={view === 'feed' ? closeApp : () => setView('feed')} className="pointer-events-auto flex h-11 w-11 touch-manipulation items-center justify-center rounded-full bg-black/30 text-white shadow-sm backdrop-blur-md active:bg-black/50" aria-label={view === 'feed' ? '退出朋友圈' : '返回朋友圈'}><ArrowLeft size={27} /></button>
              {view === 'feed' && <button type="button" onClick={() => setStrangerListOpen(true)} className="pointer-events-auto flex h-11 w-11 touch-manipulation items-center justify-center rounded-full bg-black/30 text-white shadow-sm backdrop-blur-md active:bg-black/50" aria-label="摇一摇与陌生人"><ArrowsClockwise size={23} /></button>}
            </div>
            {view === 'feed' && <div className="flex items-center gap-1">
              <button type="button" onClick={() => { resetDraft(); setComposeOpen(true); }} className="pointer-events-auto flex h-11 w-11 touch-manipulation items-center justify-center rounded-full bg-black/30 text-white shadow-sm backdrop-blur-md active:bg-black/50" aria-label="发表朋友圈"><Camera size={24} /></button>
              <button type="button" onClick={() => setView('settings')} className="pointer-events-auto flex h-11 w-11 touch-manipulation items-center justify-center rounded-full bg-black/30 text-white shadow-sm backdrop-blur-md active:bg-black/50" aria-label="朋友圈设置"><GearSix size={24} /></button>
            </div>}
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain">
          <div className="relative min-h-[268px] bg-[#a4b0bd]" style={displayProfile.cover?.startsWith('linear-gradient') ? { background: displayProfile.cover } : undefined}>
            {displayProfile.cover && !displayProfile.cover.startsWith('linear-gradient') ? <TokenImg value={displayProfile.cover} alt="朋友圈封面" className="absolute inset-0 h-full w-full object-cover" /> : null}
            {displayProfile.id === USER_PROFILE_ID && <button type="button" onClick={() => coverInputRef.current?.click()} className="absolute bottom-3 left-3 z-20 flex h-9 touch-manipulation items-center gap-1.5 rounded-full bg-black/45 px-3 text-[11px] text-white shadow-sm backdrop-blur-sm active:bg-black/60"><ImageSquare size={16} />换封面</button>}
            {view === 'profile' && displayProfile.actorType === 'npc' && <button type="button" disabled={busy} onClick={() => void addNpcAsFriend(displayProfile)} className="absolute bottom-3 left-3 z-20 flex h-10 touch-manipulation items-center gap-1.5 rounded-full bg-[#07c160] px-3.5 text-[12px] text-white shadow-sm disabled:opacity-50"><UserPlus size={16} />添加好友</button>}
            <div className="absolute -bottom-[41px] right-4 flex items-end gap-2.5">
              <span className="mb-1 text-[18px] font-semibold text-white drop-shadow">{displayProfile.displayName}</span>
              <button type="button" onClick={() => { setTimelineProfile(profile); setView('profile'); }} className="h-[72px] w-[72px] overflow-hidden border-[3px] border-white bg-[#ddd] shadow-sm">
                {displayProfile.avatar ? <TokenImg value={displayProfile.avatar} alt={displayProfile.displayName} className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center text-2xl">🙂</span>}
              </button>
            </div>
          </div>
          <div className="h-14 bg-white" />
          {isOwnTimeline && <div className="border-y border-[#eeeeee] bg-white px-4 py-3 text-[13px] text-[#576b95]">
            <button type="button" onClick={() => { markSocialInboxRead(); setView('messages'); }} className="relative mr-6">消息{unreadSocialCount > 0 && <span className="absolute -right-2 -top-1 h-1.5 w-1.5 rounded-full bg-[#fa5151]" />}</button>
          </div>}

          {view === 'feed' && friends.length > 0 && <div className="border-b border-[#ededed] bg-white px-4 py-3">
            <div className="mb-2 text-[11px] text-[#999]">我的朋友</div>
            <div className="flex gap-3 overflow-x-auto pb-0.5">
              {friends.map(friend => <button type="button" key={friend.id} onClick={() => { setTimelineProfile(friend); setView('profile'); }} className="w-11 shrink-0 text-center"><div className="h-10 w-10 overflow-hidden bg-[#e8e8e8]">{friend.avatar ? <TokenImg value={friend.avatar} alt={friend.displayName} className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center">🙂</span>}</div><div className="mt-1 truncate text-[10px] text-[#555]">{friend.displayName}</div></button>)}
              {npcProfiles.map(npc => <button type="button" key={npc.id} onClick={() => { setTimelineProfile(npc); setView('profile'); }} className="w-11 shrink-0 text-center"><div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-[#eef1f6] text-[15px]">{npc.avatar ? <TokenImg value={npc.avatar} alt={npc.displayName} className="h-full w-full object-cover" /> : '◌'}</div><div className="mt-1 truncate text-[10px] text-[#555]">{npc.displayName}</div></button>)}
            </div>
          </div>}
          {view === 'feed' && friends.length === 0 && <div className="border-b border-[#ededed] bg-white px-4 py-3"><button type="button" onClick={() => setStrangerListOpen(true)} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#fff8e9] py-2.5 text-[13px] font-medium text-[#9b792f]"><ArrowsClockwise size={18} />摇一摇，认识附近的陌生人</button></div>}

          <main className="bg-white">
            {visiblePosts.length === 0 ? (
              <div className="px-8 py-16 text-center">
                <div className="text-[15px] text-[#555]">还没有朋友圈动态</div>
                {isOwnTimeline ? <button type="button" onClick={() => { resetDraft(); setComposeOpen(true); }} className="mt-4 rounded-md bg-[#07c160] px-4 py-2 text-[13px] font-medium text-white">发表第一条</button> : <p className="mt-2 text-[12px] leading-relaxed text-[#999]">你可以在私聊里要求 {displayProfile.displayName} 发朋友圈。</p>}
              </div>
            ) : visiblePosts.map(post => (
              <article key={post.id} className="relative flex gap-2.5 border-b border-[#ededed] px-4 py-4">
                <button type="button" className="h-10 w-10 shrink-0 overflow-hidden bg-[#d9d9d9]" onClick={() => { setTimelineProfile(profileForPostAuthor(post)); setView('profile'); }}>
                  {post.authorAvatar ? <TokenImg value={post.authorAvatar} alt={post.authorName} className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center">🙂</span>}
                </button>
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => { setTimelineProfile(profileForPostAuthor(post)); setView('profile'); }} className="text-left text-[15px] font-medium text-[#576b95]">{post.authorName}</button>
                  {post.content ? <div className="mt-1 whitespace-pre-wrap break-words text-[15px] leading-[1.5] text-[#191919]">{post.content}</div> : null}
                  <MomentMediaGrid media={mediaByPost[post.id] || []} onOpen={setSelectedMedia} onGenerate={item => void generateMomentPhoto(post, item)} generatingIds={generatingMediaIds} />
                  <div className="mt-2.5 flex items-center justify-between text-[11px] text-[#999]">
                    <span>{post.pinned ? '置顶 · ' : ''}{formatMomentTime(post.createdAt)}</span>
                    <div className="flex items-center gap-2 text-[#576b95]">
                      {post.authorId === USER_PROFILE_ID && <button type="button" onClick={() => void togglePin(post)}>{post.pinned ? '取消置顶' : '置顶'}</button>}
                      <button type="button" onClick={() => setDeleteTarget(post)} aria-label="删除动态"><DotsThree size={22} weight="bold" /></button>
                      <button type="button" onClick={() => setShareTargetPost(post)} className="text-[11px]">转发</button>
                      <button type="button" onClick={() => void toggleUserReaction(post)} aria-label="点赞" className={(reactionsByPost[post.id] || []).some(reaction => reaction.actorId === USER_PROFILE_ID) ? 'text-[#e05a6e]' : ''}><Heart size={19} weight={(reactionsByPost[post.id] || []).some(reaction => reaction.actorId === USER_PROFILE_ID) ? 'fill' : 'regular'} /></button>
                      <button type="button" onClick={() => openCommentComposer(post.id)} aria-label="评论"><ChatCircleText size={19} /></button>
                    </div>
                  </div>
                  {((reactionsByPost[post.id] || []).length > 0 || (commentsByPost[post.id] || []).length > 0) && <div className="mt-2 rounded-sm bg-[#f7f7f7] px-2.5 py-2 text-[12px] leading-relaxed">
                    {(reactionsByPost[post.id] || []).length > 0 && <div className="border-b border-[#e9e9e9] pb-1.5 text-[#576b95]"><Heart size={13} weight="fill" className="mr-1 inline text-[#576b95]" />{(reactionsByPost[post.id] || []).map(reaction => reaction.actorName).join('、')}</div>}
                    {(commentsByPost[post.id] || []).map(comment => <button type="button" key={comment.id} onClick={() => { if (commentLongPressTriggered.current) { commentLongPressTriggered.current = false; return; } openCommentComposer(post.id, comment); }} onPointerDown={() => startCommentLongPress(comment)} onPointerUp={cancelCommentLongPress} onPointerCancel={cancelCommentLongPress} onPointerLeave={cancelCommentLongPress} onContextMenu={event => { event.preventDefault(); setDeleteCommentTarget(comment); }} className="mt-1 block w-full touch-manipulation text-left text-[#576b95]">
                      <span className="font-medium">{comment.actorName}</span>{comment.replyToActorId ? <><span className="text-[#555]"> 回复 </span><span className="font-medium">{interactionActorName(post, comment.replyToActorId)}</span></> : null}<span className="text-[#555]">：{comment.content}</span>
                    </button>)}
                  </div>}
                      <div className="mt-2 text-[11px] text-[#999]">长按任意评论即可删除；任意动态也可从右侧菜单删除，相关记忆会同步撤销。</div>
                </div>
              </article>
            ))}
          </main>
          </div>
        </>
      )}

      <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={event => { void addUploadedMedia(event.target.files); event.currentTarget.value = ''; }} />
      <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={event => { void updateCover(event.target.files?.[0]); event.currentTarget.value = ''; }} />

      {composeOpen && <div className="absolute inset-0 z-50 flex flex-col bg-white">
        <header className="flex h-[54px] shrink-0 items-center justify-between border-b border-[#ededed] px-3"><button type="button" onClick={() => { resetDraft(); setComposeOpen(false); }} className="p-1.5"><X size={24} /></button><span className="text-[16px] font-semibold">发表朋友圈</span><button type="button" disabled={busy} onClick={() => void publish()} className="rounded-md bg-[#07c160] px-3.5 py-1.5 text-[13px] font-medium text-white disabled:opacity-50">{busy ? '发表中' : '发表'}</button></header>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <textarea autoFocus value={draftContent} onChange={event => setDraftContent(event.target.value)} maxLength={2000} placeholder="这一刻的想法…" className="min-h-[148px] w-full resize-none border-0 text-[16px] leading-relaxed outline-none placeholder:text-[#b7b7b7]" />
          <div className="mt-2 grid max-w-[330px] grid-cols-3 gap-1">
            {draftMedia.map(item => {
              const placeholder = item.generated && (!item.url || item.url.startsWith('moments-photo-pending:'));
              return <div key={item.id} className="relative aspect-square overflow-hidden bg-[#f1f1f1]">
                {placeholder ? <div className="flex h-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-[#f2efff] via-[#faf7ff] to-[#fff1f6] px-2 text-center"><Sparkle size={18} className="text-violet-400" /><span className="line-clamp-4 text-[9px] leading-relaxed text-violet-700">{item.prompt || '待合成照片'}</span></div> : <TokenImg value={item.url} alt="已选图片" className="h-full w-full object-cover" />}
                <button type="button" onClick={() => setDraftMedia(prev => prev.filter(media => media.id !== item.id))} className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white"><X size={13} /></button>
              </div>;
            })}
            {draftMedia.length < 9 && <button type="button" aria-label="添加朋友圈照片" onClick={() => setGalleryPickerOpen(true)} className="flex aspect-square touch-manipulation items-center justify-center bg-[#f4f4f4] text-[#999]"><ImageSquare size={30} weight="thin" /></button>}
          </div>
          <button type="button" onClick={() => setPhotoPromptOpen(true)} className="mt-4 flex items-center gap-2 rounded-full bg-[#f4efff] px-3 py-2 text-[12px] text-violet-700"><Sparkle size={16} />添加照片占位（点击后合成）</button>
          <button type="button" onClick={() => setPrivacyPickerOpen(true)} className="mt-7 flex w-full items-center gap-3 border-y border-[#ededed] py-3 text-left"><LockKey size={19} className="text-[#576b95]" /><span className="flex-1 text-[14px]">谁可以看</span><span className="text-[13px] text-[#888]">{draftVisibility === 'public' ? '所有朋友' : draftVisibility === 'private' ? '仅自己' : draftVisibility === 'partial' ? `部分可见（${selectedAudienceCount}）` : `不给谁看（${selectedAudienceCount}）`} <CaretRight size={13} className="inline" /></span></button>
          {(draftVisibility === 'partial' || draftVisibility === 'exclude') && <div className="mt-3"><div className="flex flex-wrap gap-1.5"><span className="w-full text-[11px] text-[#999]">朋友圈补充分组</span>{(settings.visibilityGroups || []).map(group => <button type="button" key={group.id} onClick={() => setDraftGroupIds(prev => prev.includes(group.id) ? prev.filter(id => id !== group.id) : [...prev, group.id])} className={`rounded-full px-2.5 py-1 text-[11px] ${draftGroupIds.includes(group.id) ? 'bg-[#e8f7ee] text-[#078b43]' : 'bg-[#f2f2f2] text-[#666]'}`}>{group.name} · {group.actorIds.length}</button>)}</div><div className="mt-2 flex gap-2"><input value={visibilityGroupName} onChange={event => setVisibilityGroupName(event.target.value)} placeholder="将已单独勾选的朋友存为分组" className="min-w-0 flex-1 rounded-lg bg-[#f5f5f5] px-2.5 py-2 text-[11px] outline-none" /><button type="button" onClick={() => void createVisibilityGroup()} className="shrink-0 rounded-lg bg-[#edf6ff] px-3 text-[11px] text-[#576b95]">保存分组</button></div></div>}
          <p className="mt-3 text-[11px] leading-relaxed text-[#999]">发出后会冻结本条动态的可见对象；之后更改角色分组，不会让旧动态突然被看见或消失。</p>
        </div>
      </div>}

      {privacyPickerOpen && <div className="absolute inset-0 z-[70] flex flex-col bg-[#f7f7f7]"><header className="flex h-[54px] items-center justify-between border-b border-[#ededed] bg-white px-3"><button type="button" aria-label="返回发表朋友圈" onClick={() => setPrivacyPickerOpen(false)} className="p-1.5"><ArrowLeft size={23} /></button><span className="text-[16px] font-semibold">谁可以看</span><button type="button" onClick={() => setPrivacyPickerOpen(false)} className="px-2 text-[13px] font-medium text-[#07c160]">完成</button></header><div className="flex-1 overflow-y-auto"><div className="mt-3 bg-white">{([['public', '公开', '所有已添加的朋友可见'], ['partial', '部分可见', '只让选中的朋友看'], ['exclude', '不给谁看', '除了选中的朋友，其他朋友可见'], ['private', '仅自己', '只有你自己可见']] as const).map(([mode, title, description]) => <button type="button" key={mode} onClick={() => { setDraftVisibility(mode); if (mode === 'public' || mode === 'private') { setDraftAudience([]); setDraftGroupIds([]); } }} className="flex w-full items-center gap-3 border-b border-[#ededed] px-4 py-3.5 text-left"><span className={`flex h-5 w-5 items-center justify-center rounded-full border ${draftVisibility === mode ? 'border-[#07c160] bg-[#07c160] text-white' : 'border-[#c7c7c7]'}`}>{draftVisibility === mode && <Check size={13} weight="bold" />}</span><span><span className="block text-[14px]">{title}</span><span className="mt-0.5 block text-[11px] text-[#999]">{description}</span></span></button>)}</div>{(draftVisibility === 'partial' || draftVisibility === 'exclude') && <div className="mt-3 bg-white"><div className="px-4 py-3 text-[12px] text-[#999]">先按角色分组选择，再可单独补充角色；发出后都会冻结为具体对象。</div>{characterGroups.map(group => { const members = characters.filter(character => character.groupId === group.id); const selected = draftGroupIds.includes(group.id); return <button type="button" key={group.id} onClick={() => setDraftGroupIds(prev => selected ? prev.filter(id => id !== group.id) : [...prev, group.id])} className="flex w-full items-center gap-3 border-t border-[#ededed] px-4 py-3 text-left"><span className={`flex h-5 w-5 items-center justify-center rounded-full border ${selected ? 'border-[#07c160] bg-[#07c160] text-white' : 'border-[#c7c7c7]'}`}>{selected && <Check size={13} weight="bold" />}</span><span className="flex-1 text-[14px]">{group.name}<span className="ml-1.5 text-[11px] text-[#999]">{members.length} 位角色</span></span></button>})}<div className="border-t border-[#ededed] px-4 py-3 text-[12px] text-[#999]">单独补充</div>{friends.map(friend => <button type="button" key={friend.id} onClick={() => setDraftAudience(prev => prev.includes(friend.id) ? prev.filter(id => id !== friend.id) : [...prev, friend.id])} className="flex w-full items-center gap-3 border-t border-[#ededed] px-4 py-3 text-left"><div className="h-9 w-9 overflow-hidden bg-[#eee]">{friend.avatar ? <TokenImg value={friend.avatar} alt={friend.displayName} className="h-full w-full object-cover" /> : null}</div><span className="flex-1 text-[14px]">{friend.displayName}</span><span className={`flex h-5 w-5 items-center justify-center rounded-full border ${draftAudience.includes(friend.id) ? 'border-[#07c160] bg-[#07c160] text-white' : 'border-[#c7c7c7]'}`}>{draftAudience.includes(friend.id) && <Check size={13} weight="bold" />}</span></button>)}</div>}</div></div>}

      {galleryPickerOpen && <div className="absolute inset-0 z-[70] flex flex-col bg-[#f7f7f7]"><header className="flex h-[54px] shrink-0 items-center justify-between border-b border-[#ededed] bg-white px-3"><button type="button" aria-label="返回发表朋友圈" onClick={() => setGalleryPickerOpen(false)} className="p-1.5"><ArrowLeft size={23} /></button><span className="text-[16px] font-semibold">选择照片</span><span className="w-9" /></header><div className="shrink-0 bg-white px-3 py-3"><div className="grid grid-cols-2 gap-2"><button type="button" className="rounded-xl bg-[#edf6ff] px-3 py-3 text-left text-[#576b95]"><span className="block text-[13px] font-medium">小手机相册</span><span className="mt-0.5 block text-[10px] text-[#8794aa]">角色与聊天保存的图片</span></button><button type="button" onClick={() => fileInputRef.current?.click()} className="rounded-xl bg-[#eaf8ef] px-3 py-3 text-left text-[#078b43]"><span className="flex items-center gap-1 text-[13px] font-medium"><Plus size={14} />手机系统相册</span><span className="mt-0.5 block text-[10px] text-[#6e9a7d]">打开 iPhone 的照片选择器</span></button></div></div><div className="flex-1 overflow-y-auto p-1.5"><div className="grid grid-cols-3 gap-1.5">{gallery.map(image => { const selected = allDraftUrls.has(image.url); return <button type="button" key={image.id} onClick={() => toggleGalleryImage(image)} className="relative aspect-square overflow-hidden bg-white"><TokenImg value={image.url} alt="小手机相册图片" className="h-full w-full object-cover" />{selected && <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-[#07c160] text-white"><Check size={13} weight="bold" /></span>}</button>; })}</div>{gallery.length === 0 && <div className="py-20 text-center text-[13px] text-[#999]">小手机相册里还没有图片，也可以从上方打开手机系统相册。</div>}</div></div>}

      {photoPromptOpen && <div className="absolute inset-0 z-[75] flex items-end bg-black/35 p-3"><div className="w-full rounded-2xl bg-white p-4"><div className="flex items-center justify-between"><div className="text-[16px] font-semibold">添加照片占位</div><button type="button" aria-label="关闭照片占位编辑" onClick={() => setPhotoPromptOpen(false)}><X size={20} /></button></div><p className="mt-2 text-[11px] leading-relaxed text-[#888]">先写下想分享的画面，动态发表后点击占位卡才会调用已配置的生图模型。</p><textarea autoFocus value={draftPhotoPrompt} onChange={event => setDraftPhotoPrompt(event.target.value)} maxLength={1000} placeholder="例如：窗边一杯刚泡好的热咖啡，午后自然光…" className="mt-3 min-h-[100px] w-full resize-none rounded-xl bg-[#f7f7f7] px-3 py-2.5 text-[14px] outline-none" /><button type="button" onClick={addPhotoPlaceholder} className="mt-3 w-full rounded-xl bg-[#07c160] py-2.5 text-[13px] font-medium text-white">加入这条朋友圈</button></div></div>}

      {activeCommentPostId && <div className="absolute inset-x-0 bottom-0 z-30 border-t border-[#e5e5e5] bg-white p-3 shadow-[0_-6px_20px_rgba(0,0,0,0.08)]"><div className="mb-2 text-[12px] text-[#777]">{replyingTo ? `回复 ${replyingTo.actorName}` : '评论这条朋友圈'}</div><div className="flex items-end gap-2"><textarea autoFocus value={commentDraft} onChange={event => setCommentDraft(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submitComment(); }} maxLength={500} placeholder="说点什么…" className="min-h-[38px] flex-1 resize-none rounded-md bg-[#f5f5f5] px-3 py-2 text-[14px] outline-none" /><button type="button" disabled={!commentDraft.trim() || busy} onClick={() => void submitComment()} className="rounded-md bg-[#07c160] px-3 py-2 text-[13px] text-white disabled:opacity-40">发送</button></div><button type="button" onClick={() => { setActiveCommentPostId(null); setReplyingTo(null); setCommentDraft(''); }} className="mt-2 text-[11px] text-[#888]">取消</button></div>}

      {selectedMedia && <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/95 p-3" role="dialog" aria-label="查看朋友圈图片" onClick={() => setSelectedMedia(null)}><button type="button" className="absolute right-3 flex h-11 w-11 touch-manipulation items-center justify-center rounded-full bg-white/15 text-white" style={{ top: 'calc(var(--chrome-top, var(--safe-top, 0px)) + 12px)' }} onClick={() => setSelectedMedia(null)}><X size={22} /></button><div className="max-h-full max-w-full" onClick={event => event.stopPropagation()}><TokenImg value={selectedMedia.url} alt="朋友圈大图" className="max-h-full max-w-full object-contain" /></div></div>}

      {shareTargetPost && <div className="absolute inset-0 z-40 flex items-end bg-black/35 p-3"><div className="max-h-[75%] w-full overflow-hidden rounded-2xl bg-white"><div className="flex items-center justify-between border-b border-[#ededed] px-4 py-4"><div><div className="text-[16px] font-semibold">转发给谁</div><p className="mt-1 text-[11px] text-[#888]">只在你主动选择时发进对应私聊。</p></div><button type="button" onClick={() => setShareTargetPost(null)}><X size={20} /></button></div><div className="max-h-[48vh] overflow-y-auto">{friends.length === 0 ? <div className="px-4 py-7 text-center text-[13px] text-[#999]">还没有可转发的角色好友。</div> : friends.map(friend => <button type="button" key={friend.id} disabled={busy} onClick={() => void forwardPostToCharacter(shareTargetPost, friend)} className="flex w-full items-center gap-3 border-b border-[#f0f0f0] px-4 py-3.5 text-left disabled:opacity-50"><div className="h-10 w-10 overflow-hidden bg-[#eee]">{friend.avatar ? <TokenImg value={friend.avatar} alt={friend.displayName} className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center">🙂</span>}</div><span className="flex-1 text-[14px]">{friend.displayName}</span><CaretRight size={17} className="text-[#aaa]" /></button>)}</div></div></div>}

      {deleteTarget && <div className="absolute inset-0 z-40 flex items-end bg-black/35 p-3"><div className="w-full overflow-hidden rounded-2xl bg-white text-center"><div className="border-b border-[#ededed] px-5 py-5"><div className="text-[16px] font-semibold">删除这条朋友圈？</div><p className="mt-2 text-[12px] leading-relaxed text-[#888]">如果其中的图片来自小手机相册，你可以选择保留或一并删除相册副本。</p></div><button type="button" disabled={busy} onClick={() => void confirmDelete(false)} className="flex w-full items-center justify-center gap-2 border-b border-[#ededed] py-4 text-[15px] text-[#576b95]"><Trash size={17} />只删动态，保留相册照片</button><button type="button" disabled={busy} onClick={() => void confirmDelete(true)} className="w-full border-b border-[#ededed] py-4 text-[15px] text-[#e15b5b]">动态和相册副本都删除</button><button type="button" onClick={() => setDeleteTarget(null)} className="w-full py-4 text-[15px] text-[#555]">取消</button></div></div>}
      {deleteCommentTarget && <div className="absolute inset-0 z-50 flex items-end bg-black/35 p-3"><div className="w-full overflow-hidden rounded-2xl bg-white text-center"><div className="border-b border-[#ededed] px-5 py-5"><div className="text-[16px] font-semibold">删除这条评论？</div><p className="mt-2 text-[12px] text-[#888]">评论、依附它的回复以及相关事件记忆会一并撤销；原动态保留。</p></div><button type="button" disabled={busy} onClick={() => void confirmDeleteComment()} className="w-full border-b border-[#ededed] py-4 text-[15px] text-[#e15b5b]">删除评论</button><button type="button" onClick={() => setDeleteCommentTarget(null)} className="w-full py-4 text-[15px] text-[#555]">取消</button></div></div>}

      {strangerListOpen && <div className="absolute inset-0 z-[55] flex flex-col bg-[#f7f7f7]">
        <header className="flex h-[56px] shrink-0 items-center justify-between border-b border-[#ededed] bg-white px-2.5"><button type="button" onClick={() => setStrangerListOpen(false)} className="flex h-11 w-11 touch-manipulation items-center justify-center"><ArrowLeft size={25} /></button><span className="text-[16px] font-semibold">摇一摇</span><span className="w-11" /></header>
        <div className="flex-1 overflow-y-auto"><div className="mt-3 bg-white px-4 py-4"><div className="text-[13px] font-semibold text-[#333]">附近的人</div><p className="mt-1 text-[11px] leading-relaxed text-[#888]">摇到的人会保留在这里，可以继续临时聊天；只有你主动添加后才会成为正式角色好友。</p><button type="button" disabled={strangerBusy} onClick={() => void shakeStranger()} className="mt-4 flex w-full touch-manipulation items-center justify-center gap-2 rounded-xl bg-[#07c160] py-3 text-[14px] font-medium text-white disabled:opacity-50"><ArrowsClockwise size={19} />{strangerBusy ? '正在摇一摇…' : '摇一摇找人'}</button></div><section className="mt-3 bg-white"><div className="px-4 py-3 text-[12px] text-[#999]">临时聊天</div>{tempStrangers.length === 0 ? <div className="border-t border-[#ededed] px-4 py-10 text-center text-[13px] text-[#999]">还没有遇到陌生人。</div> : tempStrangers.map(stranger => <button type="button" key={stranger.id} onClick={() => { setStrangerListOpen(false); void openSavedStranger(stranger); }} className="flex w-full touch-manipulation items-center gap-3 border-t border-[#ededed] px-4 py-3.5 text-left active:bg-[#f8f8f8]"><div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#edf5ff] text-[#576b95]"><UserPlus size={20} /></div><span className="min-w-0 flex-1"><span className="block truncate text-[14px] text-[#333]">{(stranger.persona || '陌生人').split('，')[0]}</span><span className="mt-0.5 block truncate text-[11px] text-[#999]">点击继续临时聊天</span></span><CaretRight size={18} className="text-[#bbb]" /></button>)}</section></div>
      </div>}

      {activeStranger && <div className="absolute inset-0 z-[60] flex flex-col bg-[#f7f7f7]">
        <header className="flex h-[56px] shrink-0 items-center justify-between border-b border-[#ededed] bg-white px-2.5">
          <button type="button" onClick={() => setActiveStranger(null)} className="flex h-11 w-11 touch-manipulation items-center justify-center"><ArrowLeft size={25} /></button>
          <span className="text-[16px] font-semibold">陌生人资料</span>
          <div className="flex items-center">
            <button type="button" disabled={!hasUnansweredStrangerMessages || strangerBusy} onClick={() => void requestStrangerReply()} className="flex h-11 w-11 touch-manipulation items-center justify-center text-[#576b95] disabled:opacity-30" aria-label="让对方回复"><PaperPlaneTilt size={20} weight="fill" /></button>
            <button type="button" disabled={strangerBusy} onClick={() => void addStrangerAsFriend()} className="flex h-9 touch-manipulation items-center gap-1 rounded-full bg-[#07c160] px-3 text-[12px] text-white disabled:opacity-50"><UserPlus size={15} />加好友</button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto">
          <div className="bg-white px-5 py-5">
            <div className="flex items-start gap-3"><div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#edf5ff] text-[#576b95]"><UserPlus size={26} /></div><div className="min-w-0 flex-1"><div className="text-[18px] font-semibold text-[#333]">{activeStranger.displayName}</div><div className="mt-1 text-[12px] leading-relaxed text-[#888]">{activeStranger.bio}</div></div><button type="button" onClick={() => { const record = tempStrangers.find(item => item.profileId === activeStranger.id); if (record) setStrangerDeleteTarget(record); }} className="flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center rounded-full text-[#c85d5d] active:bg-[#fff0f0]" aria-label="删除临时陌生人"><Trash size={19} /></button></div>
          </div>
          <section className="mt-3 bg-white px-4 py-4"><div className="mb-3 text-[13px] font-semibold text-[#555]">最近十条朋友圈</div>{!settings.strangersCanViewTen ? <p className="text-[12px] leading-relaxed text-[#999]">对方没有开放“陌生人查看十条”，暂时看不到朋友圈。</p> : strangerVisiblePosts.length === 0 ? <p className="text-[12px] text-[#999]">你还没有公开的朋友圈动态。</p> : strangerVisiblePosts.map(post => <div key={post.id} className="border-t border-[#f0f0f0] py-3"><div className="whitespace-pre-wrap text-[13px] leading-relaxed text-[#333]">{post.content || '分享了一张照片'}</div><div className="mt-1 text-[10px] text-[#aaa]">{formatMomentTime(post.createdAt)}</div></div>)}</section>
          <section className="mt-3 bg-white px-4 py-4"><div className="mb-3 text-[13px] font-semibold text-[#555]">临时聊天</div>{strangerTranscript.length === 0 ? <p className="text-[12px] text-[#999]">还没有开始聊天。聊得来后，可以把对方正式加为角色好友。</p> : <div className="space-y-2">{strangerTranscript.map(line => <div key={line.id} className={`flex ${line.sender === 'user' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[82%] rounded-2xl px-3 py-2 text-[13px] leading-relaxed ${line.sender === 'user' ? 'bg-[#95ec69] text-[#1f3d1b]' : 'bg-[#f1f1f1] text-[#333]'}`}>{line.content}</div></div>)}</div>}</section>
        </div>
        <div className="flex shrink-0 items-end gap-2 border-t border-[#e5e5e5] bg-white px-3 pt-3" style={{ paddingBottom: 'calc(max(env(safe-area-inset-bottom, 0px), var(--safe-bottom, 0px)) + 14px)' }}>
          <textarea value={strangerDraft} onChange={event => setStrangerDraft(event.target.value)} enterKeyHint="send" rows={1} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void queueStrangerMessage(); } }} placeholder="和陌生人聊两句…" className="min-h-[42px] max-h-24 flex-1 resize-none rounded-xl bg-[#f4f4f4] px-3 py-2.5 text-[16px] outline-none" />
          <button type="button" disabled={!strangerDraft.trim() || strangerBusy} onClick={() => void queueStrangerMessage()} className="flex h-11 w-11 touch-manipulation items-center justify-center rounded-full bg-[#07c160] text-white disabled:opacity-40" aria-label="发送临时消息"><PaperPlaneTilt size={18} weight="fill" /></button>
        </div>
      </div>}

      {strangerDeleteTarget && <div className="absolute inset-0 z-[80] flex items-end bg-black/35 p-3"><div className="w-full overflow-hidden rounded-2xl bg-white text-center"><div className="border-b border-[#ededed] px-5 py-5"><div className="text-[16px] font-semibold">删除这位临时陌生人？</div><p className="mt-2 text-[12px] leading-relaxed text-[#888]">临时档案和临时聊天都会删除；如果已经正式添加为好友，不会从这里删除正式角色。</p></div><button type="button" disabled={strangerBusy} onClick={() => void deleteTemporaryStranger()} className="w-full border-b border-[#ededed] py-4 text-[15px] text-[#e15b5b]">删除临时角色与聊天</button><button type="button" onClick={() => setStrangerDeleteTarget(null)} className="w-full py-4 text-[15px] text-[#555]">取消</button></div></div>}
    </div>
  );
};

export default MomentsApp;
