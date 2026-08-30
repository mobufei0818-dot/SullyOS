/**
 * 非聊天任务的通用约定（环境无关叶子模块）
 *
 * 主动消息 2.0 的调度器本来只跑一种任务：到点给用户说句话。现在还要跑一批**不说话**的
 * 后台活儿——整理一份数据、跑一次总结、算一份报告。它们跟聊天任务共用同一套调度
 * （cron 每分钟 + 租约 + 心跳 + 分组串行 + 重试退避 + 时区感知的循环），只是到点之后
 * 做的事不一样。
 *
 * 这份文件定的是「怎么把这两类任务分开」：任务上怎么标种类、一次性输入放在云端哪个
 * 抽屉、以及这些任务在用户的任务清单里怎么不露脸。具体某一种任务长什么样，各自另开
 * 一份契约（第一个是 amsgPlateJob.ts）。
 *
 * 往这里加代码前先确认：不 import 任何带浏览器依赖的模块（db / safeApi / context 等）。
 * `pnpm build:workers` 会把这份打进 amsg worker bundle，带进浏览器依赖会在构建期直接暴露。
 */

// ─── 任务种类 ─────────────────────────────────────────

/**
 * 任务 metadata 上标业务种类的键。
 *
 * 到点触发只有 `onBeforeFire` 一个入口，所有任务都从那儿进；worker 靠这个键把
 * 「后台整理一份数据」和「到点给用户说句话」分开，各走各的 handler
 * （见 worker/amsg/src/fireKinds.ts）。没有这个键的就是聊天任务，照旧走原来那条路
 * ——所有存量任务都落在这一档。
 *
 * 跟 amsgMode / amsgExpirePolicy 这些一样带 amsg 前缀：metadata 是各方共用的口袋，
 * 光叫 kind 太容易跟别人撞名。
 */
export const AMSG_TASK_KIND_KEY = 'amsgKind';

/** 读出任务的业务种类；没标就是 null（= 聊天任务）。 */
export const readTaskKind = (metadata: Record<string, unknown> | null | undefined): string | null => {
  const raw = metadata?.[AMSG_TASK_KIND_KEY];
  return typeof raw === 'string' && raw ? raw : null;
};

/**
 * 后台任务行的 `messageSubtype`。
 *
 * 任务清单跟远端对账时靠它把这些行挡在外面：它们不是用户排的主动消息，进了清单会显示
 * 成「待触发的任务」，还可能被「取消全部」顺手掐掉。跟即时对话那个 subtype 一个道理。
 */
export const AMSG_BACKGROUND_JOB_SUBTYPE = 'job';

// ─── 一次性输入的云端抽屉 ─────────────────────────────

/**
 * 后台任务的一次性输入存放的 client_state 命名空间。
 *
 * 跟角色状态（`amsg:char:<id>` 里的 fire_pack / tool_pack）分开放，因为这里的东西是
 * **一次性**的：跑完就没人再回来看，也没人回来删。worker 的 config 给这个命名空间配了
 * `clientStateTtl`，cron 每跳顺手把过期的清掉——角色状态那边是要长期留着的，不能跟它
 * 共用一个命名空间，否则 TTL 会把 fire_pack 一起清了。
 */
export const AMSG_JOB_NAMESPACE = 'amsg:job';

/** 一次性输入在云端留几天。够重试几轮，又不至于攒着白占库。 */
export const AMSG_JOB_TTL_DAYS = 3;

/** 任务 metadata 上放 job 编号的键（handler 靠它去抽屉里取自己那份输入）。 */
export const AMSG_JOB_ID_KEY = 'amsgJobId';
