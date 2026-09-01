# instant chat 实施契约（给施工 agent）

设计动机与取舍见 [`amsg2-instant-chat.md`](./amsg2-instant-chat.md)，本文件是拍板后的实现契约：
端点形状、数据格式、必须先验证的上游行为、分工边界。施工前先通读两份。

## 总体架构（定案）

- **不改上游 npm 包** `@rei-standard/*`（路由/D1/cron/推送都住在
  `node_modules/@rei-standard/amsg-server/dist/chunk-RRWCPPOY.mjs`，只读参考，不动）。
  全部改动落在本仓库：`worker/amsg/src/`（包装层）、`utils/` 叶子模块、前端。
- 防双跑复用上游 `claimTask` 的 `lease_until` 条件更新；每分钟 cron 是兜底捡漏者。
- 任务行型：`message_type = 'auto'` + `messageSubtype: 'instant-chat'`
  + `metadata: { amsgMode: 'instant', amsgInstantChat: true, charId }`。
  用 'auto' 是为了确定走 hooks + LLM 的 fire 管线；push 载荷的 `messageType`
  期望取自 `metadata.amsgMode`（见 V4），这样客户端收到的是
  `messageType: 'instant'`。`messageSubtype` 上游只当自由文本标签原样透传，
  客户端拿它做面板对账的过滤判据：即时对话的行不补进任务清单（连同
  `status = 'failed'` 的行一起排除），否则用户正等着的这一轮会显示成待触发的
  排程任务、还可能被「取消全部」顺手掐掉。
- **durability 原则**：202 之前任务行必须已落 D1。`ctx.waitUntil` 只负责快，
  cron 负责稳。isolate 死了 → lease 过期 → cron 重跑，消息不丢。

## 新端点 `POST /instant-chat`（包装层路由）

- 路由位置：`worker/amsg/src/index.ts` 的 default export，和 `/config-check`、
  `/debug` 同级（后缀匹配、OPTIONS 204、CORS 头同现有约定，注意 `index.ts:1361`
  和上游 chunk `:3297` 的 CORS 允许头两处同步问题）。
- 鉴权：与上游一致——设了 `AMSG_SERVER_TOKEN` 就要求 `X-Client-Token` 常时比较；
  `X-User-Id` 必须 UUID v4。内部转发的子请求带全套头，上游会再验一次（上游是权威）。
- Body（明文 JSON 外壳，内含两个客户端预加密的信封）：

  ```jsonc
  {
    "statePayload": "<加密信封：即 PUT /client-state 的完整 body>",
    "taskPayload": "<加密信封：即 POST /schedule-message 的完整 body>"
  }
  ```

  taskPayload（信封内）固定带 `immediate: true`（amsg-server 2.6.0-next.15 起：
  落库即到期，不带 `firstSendTime`）；顶替上一条时带 `supersedesUuid`（上游在
  建新任务的同一事务里取消旧的，原子）。外壳不再有明文 supersedesUuid。

- 处理步骤（严格顺序，两个 await 失败即向客户端返回明确错误，不落任务）：
  1. 内部 `upstream.fetch` 转发 `PUT /client-state`（statePayload）→ 必须成功。
     HTTP ok 还不够：上游按 updatedAt 条件写（旧不盖新），成功体 `data.skippedEntries`
     里点名了 `fire_pack` 条目时同样打回——`409 INSTANT_CHAT_STATE_STALE`，绝不落任务
     （否则 fire 拿旧 chat 段答话）。
     客户端拿到这个码会自愈一次：读回云端那几行的 `updatedAt`、把本地水位抬过去
     （`utils/amsgStateClock.ts`）、重新盖戳再发一次。设备时钟只要领先过真实时间，云端
     那一行就带着一个还没到的时刻，本地墙钟从此跨不过去，那个角色发一句挂一句，把系统
     时间调回来也没用；水位是这条路的唯一出路。对齐不动才是真被别人写了新的，那时不重发。
  2. 内部转发 `POST /schedule-message`（taskPayload）→ 必须成功，拿到 uuid
     （顶替在上游事务内完成）。
  3. 返回 `202 { status: 'accepted', uuid }`。
  4. `ctx.waitUntil(upstream.scheduled(合成 event, env))` 立即触发一次 tick，
     捡起刚落的行（与真 cron 并发时由 claim/lease 天然互斥）。
- `export default` 的 `fetch` / `scheduled` 签名补上第三个参数 `ctx`
  （上游签名只收两个参数，多传无害；`index.ts:1509-1510` 的注释要同步改）。
- `/config-check` 的返回里加包装层能力标志（如 `instantChat: true`），设置页
  用它做唯一版本门槛（开发期规矩：门槛只留一处，不做逐调用 capability 预检）。

## 必须先验证的上游行为（读 chunk-RRWCPPOY.mjs，结论写进报告）

| # | 验证什么 | 影响 |
|---|---------|------|
| V1 | `MIN_SCHEDULE_LEAD_MS`（chunk `:805`）是否约束 `/schedule-message` 的 `next_send_at`，即「立刻执行」的行能不能建 | 若约束 → 改为包装层直插 D1（需查 `createTask` 对 `encrypted_payload` 的实际存储格式，转发方案作废） |
| V2 | `message_type='auto'` 的行被 tick 捡起后 hooks（`onBeforeFire`/`runAgenticFire`）是否照常运行（`taskNeedsLlm` chunk `:819`） | 若不走 → 换行型或换触发方式 |
| V3 | `upstream.scheduled(event, env)` 合成 event 需要哪些字段 | waitUntil 里怎么造 event |
| V4 | `buildScheduledPush`（`agentic.ts:381`）的 `messageType` 是否直接取 `metadata.amsgMode`，能否透出 `'instant'` | 客户端按 messageType 分轨 |
| V5 | 前端 `encryptPayload`（`utils/activeMsgClient.ts:890`）产出的信封是否与 SDK 内部一致、可被上游解开 | 不行 → 退化为两请求方案：SDK `putClientState` 先行 + `/instant-chat` 只带 taskPayload（可接受，报告里注明） |
| V6 | fire 链总超时（默认 5 轮/240s，chunk `:1070-1196`）能否经 `buildWorkerConfig` 配置，能否对 instant 任务单独调大 | 目标 ≥600s（cron 墙钟 15 分钟内）；只能全局调就全局调到 600s，并把 lease 变长（totalTimeoutMs + 2min）的影响写进报告 |

## fire_pack v7：`chat` 字段

- `AmsgFirePack`（`utils/amsgFirePack.ts`）增可选字段：

  ```ts
  chat?: {
    // 这一轮的 fullMessages（结构与本地生成走 /chat/completions 那份一致）。
    // chat.messages 不含前端时效段（时钟/节日/天气/热搜/MCP 说明），这些由 worker
    // 在 fire 时刻的时效块独家供给。
    // content 允许结构化片段数组（图片消息的 text + image_url），worker 只搬运不解释；
    // 超出 client_state 单条预算时从最旧的消息开始把 image_url 降回文字段，
    // 最新一条用户消息的图片永不降级，仍超预算则整轮明确报错。
    messages: { role: string; content: string | Array<{ type: string; [key: string]: unknown }> }[];
    builtAt: number;
  }
  ```

- `FIRE_PACK_VERSION` 6 → 7。开发期规矩：**不做旧格式兼容**，v6 包 parse 直接拒
  （现有定时任务的 fire_pack 会在下一轮 dirty-sync 时以 v7 重传，无需迁移代码）。
- `onBeforeFire`（`index.ts:791`）新增 instant 分支：`metadata.amsgInstantChat`
  为真时——
  - 用 `pack.chat.messages` 组请求消息（不走 `renderFirePack` 模板渲染），
    在末尾追加 system 块注入时效内容：当前时间（沿用角色时区约定）、
    实时世界块（`buildRealtimeWorldBlock`）。
  - **跳过**：presence gate、expire guard（`shouldExpireFire`）、
    task-instruction 检查——这些是「主动消息到点还该不该发」的语义，对
    「用户刚发消息等回复」不适用。
  - **照常**：工具循环、表情包、后台 MCP、self_log、任务列表块（角色平时聊天
    也能排未来消息，这个能力对话里同样要有）。
  - `pack.chat` 缺失而 metadata 标了 instant → 按失败处理（防止拿主动消息模板
    错答聊天）。

## push metadata 扩展字段

即时对话往返用到的 metadata 键，一并记在这（发侧走加密信封，回程随 push 明文 metadata）：

- 发侧（任务 metadata，走加密信封）：`amsgEmotionEval`（评估模板 + 副 API 凭据；worker
  在 `onBeforeFire` 捕获后就地删除，喂给 push 构建前再剥一层——凭据绝不进任何 push/outbox）。
- 回程（push metadata）：`amsgEmotionUpdate` / `amsgEmotionDone` / `amsgEmotionError`
  （评估结果 / 熄灯信号 / 脱敏后的失败原因）、`amsgReasoning`（思考链，只挂第一条 push、
  只在即时对话轮）、`amsgToolTrace`（`[{name,count}]`，只数真跑过的调用、只挂末条 push、
  只在即时对话轮）、`amsgUsage`（`{promptTokens, completionTokens}`，同样只挂末条 push、
  只在即时对话轮）。
- `amsgUsage` 的去处：客户端把它补进「设置 → API 调用记录」里那笔云端调用（发出时先落
  一笔 pending，收到末条推送时回填 Token）。它是**最后一次**模型调用的用量——带工具的
  一轮会连着调好几次模型，中间几次的数云端没留，所以跑过工具时那笔记录会标「只算末轮」。
- 超限旁路：`amsgEmotionRef` / `amsgReasoningRef`（值挪进 client_state，键
  `emotion_update:<clientTaskId>` / `reasoning:<clientTaskId>`）。

## outbox（push 丢失的拉取兜底）

- 服务端 `message_outbox` 表（按用户存，不分角色也不分消息类型）。每条 push 发出去
  **之前**先落一行，客户端落库之后 `POST /outbox/ack` 销账，所以「哪些还没收下」是
  查得出来的事实，不用拿本地聊天记录去猜。行的保留期跟着 Web Push TTL 上限（四周）走。
- 写入点在库层的 push 发送路径上，定时主动消息和即时对话的产物都记。
- 客户端拉账本分两类时机，别混：
  - **上线补收**（`catchUpMissedPushes`）：冷启动、回到前台各一次，带 60s 节流，
    **不看有没有在等回复**。定时主动消息由云端到点自己发，客户端不产生任何「我在等它」
    的本地状态——只在等回复时才拉的话，这类消息的推送丢了就永远没人去捞。
  - **等回复时的点名**（`runInstantChatStatusCheck`）：每 60s 一跳，下结论前必拉一次
    最新的，不受节流管（拿旧账本去判「回复取不回」会误杀还在路上的回复）。
- 补收只上屏两天内的条目，更老的只销账（那个岁数的推送推送服务早就不投了）。超窗销掉
  几条会数出来交给界面说一句——这一销消息就永久拿不回来了，不能一声不响。
- 头一趟拉账本走「存量整批销账、一条不上屏」（`adoptOutboxBacklog`）：worker 先更新
  建了表、前端还是老版本那段时间，账本会攒下一批「其实收到了、只是不会销账」的行，
  当补收倒出来就是重放。用户在设置页手点的那次补收例外（`treatBacklogAsMissed`）——
  他是察觉到消息没来才点的，这个判断他自己做得了。

## 失败路径

- 客户端「正在输入」的主判定是**云端任务状态**：还欠着回复时每 60s 查一次
  `GET /message?id=<uuid>`，`pending` 就继续等，行已失败 / 行没了才收尾；
  查询本身失败不立刻下结论，等下一跳。下结论前先拉一次 outbox。
  **只在前台查**：页面不可见时既不查也不排下一跳，回前台立刻点一次名把周期接上。
  **失联判死线**：联网状态（`navigator.onLine !== false`）下同一轮连续 5 次查询
  失败 → worker 多半已不在（被删 / 密钥换了），明确收尾并提示去设置页重新连接
  验证；离线时的失败不计数。「不按时长宣判」只对云端还答得上话的等待成立。
- worker 留痕 `chat_fail`（char namespace 的 client_state，认 uuid）：fire 收尾
  失败、过期跳过（reason `stale`）、以及 skip-push（reason `empty-generation` /
  `side-effects-only`——即时对话的一次性行会被上游当成功消费删掉，客户端只能看到
  gone）三处都写。客户端 completed 与 gone 两个分支都点名读回翻成人话，别把
  「没生成出来」说成「回复没能取回」。
- worker 侧若现有 hook（如 `onFireSettled`）拿得到失败结局且拿得到 push 发送
  能力 → 尽力补发一条 `messageKind: 'error'`（SW 已有该分轨）。拿不到就算了，
  别为此改上游。
- POST `/instant-chat` 任何一步 await 失败 → 客户端收到明确错误 → 界面报
  发送失败可重试。**绝不静默转回本地生成**。

## 已拍板的行为语义

- 连发两条：第二条 POST 用 `supersedesUuid` 顶掉未认领的上一条（合并成一起回）。
  上一条已认领（正在生成）→ 让它跑完，新任务靠 `serialize_group`（= charId）
  排队，接受小概率两条相近回复。
- push 成功后、行删除前 isolate 死掉 → cron 重跑 → 重复回复。窗口极小，
  与现有定时任务同类，接受。
- 群聊不动（收件箱按 charId 路由，群聊没有 charId）。
- presence / dirty-sync 机制**保留不退役**（开关关闭的用户仍走本地路径需要它们，
  打脏后微任务内立即上传，同一轮的连环打脏合并成一次）；instant 分支天然绕开：
  不起 presence 心跳，POST 即上传所以不 markDirty。

## 分工与边界

**Agent 1（worker 侧）只准动**：`worker/amsg/src/index.ts`、
`worker/amsg/src/` 下新文件（如 `instantChat.ts`）、`utils/amsgFirePack.ts`
（v7 类型与 parse）、对应 `*.test.ts`。

**Agent 2（前端侧）只准动**：`hooks/useChatAI.ts`、`apps/Chat.tsx`（最小接线）、
`utils/activeMsgClient.ts`、`utils/activeMsgRuntime.ts`、`types.ts`
（`ActiveMsg2GlobalConfig` 加字段）、
`components/settings/ActiveMsgGlobalSettingsModal.tsx`、`worker/sw-keep-alive.ts`
（仅 when-hidden 调查结论落地）、对应测试。接缝在 `useChatAI.ts:1076`
现有 instant-push 分支旁，同样排除 mcd/luckin/mcp 本地工具循环场景。

**共同纪律**：
- 禁跑任何改状态的 git 命令；禁碰边界外文件。
- `pnpm vitest run` 全绿；`pnpm build:workers` 通过（叶子模块不得引入浏览器依赖，
  worker 侧新 import 一律过一遍这条）。
- 新行为配回归守卫测试（旧行为下会挂、修好后过）。
- 测试 fixture 里的用户名用「小明」，不写真实姓名。
- UTF-8；注释密度与风格跟随周边代码。
