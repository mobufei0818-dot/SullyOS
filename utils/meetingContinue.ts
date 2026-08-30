/**
 * “继续”在记录里只保留一个简短、可读的用户侧占位；真正交给模型的调度词
 * 按模式单独构造，避免技术指令污染沉浸式阅读、导出和角色长期记忆。
 */
export const MEETING_CONTINUE_DISPLAY_TEXT = '（继续）';

const safeName = (name: string | null | undefined, fallback: string): string => name?.trim() || fallback;

export const buildInPersonContinueInstruction = (
    userName: string | null | undefined,
    characterName: string | null | undefined,
): string => {
    const user = safeName(userName, '用户');
    const character = safeName(characterName, '角色');
    return `[继续当前见面]
本轮${user}没有主动说话，也没有采取新的行动。这不代表离场、结束或切回线上聊天：${user}与${character}仍然真实地待在同一物理空间，正在面对面共处。
请严格沿用当前见面模式已经设定的角色、关系、场景、文风、叙事人称与视觉小说格式，由${character}根据自己的性格、意愿和眼前正在发生的事主动把这一刻继续下去。加强真实陪伴感：让角色通过自然的注视、距离、动作、停顿、环境互动或主动开口陪在${user}身边，并让相处产生一项具体的新变化，而不是远程发消息、原地等待或反问${user}接下来要做什么。
不要解释、复述或在正文中暴露这条调度指令；不要擅自替${user}补写新的主动行为。`;
};

export const buildStoryContinueInstruction = (identityName: string | null | undefined): string => {
    const identity = safeName(identityName, '当前用户侧角色');
    return `[继续当前剧情]
本轮${identity}没有新增主动行为。把这视为故事中的一次自然留白，不代表场景结束，也不要求用户补充输入。
请严格沿用当前剧情已经启用的原生预设及其文风、叙事视角、格式规则、转述档位和“用户执笔权”边界继续下一回合。让其他角色的自身目标、现场时间、既有因果和已经启动的后果主动向前运行，形成新的动作、信息、关系变化或局面转向；不要切换成普通聊天，不要停下来询问${identity}要做什么。
不要解释、复述或在正文中暴露这条调度指令。`;
};
