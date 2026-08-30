/**
 * 删角色时的云端善后：把 ta 在 worker D1 `client_state` 里的那份数据清掉。
 *
 * 云端存的不是元数据，是**完整的角色系统提示词 + 最近 30 条对话原文**（fire_pack，
 * 实测一个角色 32KB 起步），旁边还有 tool_pack、活跃会话租约、以及 push 装不下时
 * 旁路存的小红书会话。删除确认框跟用户说的是「该操作不可恢复，记忆将被清空」，
 * 用户按下确认那一刻的预期就包含云端那份；留着既对不上这句承诺，也让每删一个角色
 * 就在 D1 里堆一份聊天记录。设置页那个「清除云端状态」是全局按钮、要用户主动去点，
 * 指望不上它替删角色收尾。
 *
 * 这一步是 best-effort：断网、worker 挂了都不该拦着角色删掉（用户想删的是这个角色，
 * 而且今天删不掉明天还是删不掉）。所以异常在这里就地吞掉、用返回值把结果交给调用方，
 * 调用方照常删本地记录，只是多弹一条提示。
 */

import { CharacterProfile } from '../types';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { charCredIds, forgetCredIds } from './amsgLlmCredentials';

export type CharCloudStateCleanup =
  /** 没有云端可清（角色不存在，或压根没填 worker 地址）—— 一个请求都没发。 */
  | { status: 'skipped' }
  /** 清完了；keys 是实际被清空的条目（本来就空的角色是空数组）。 */
  | { status: 'cleared'; keys: string[] }
  /** 没清成（断网 / worker 挂了 / 没填 worker 地址）。角色照删，调用方负责提示。 */
  | { status: 'failed'; error: unknown };

/**
 * 判断这个角色云端有没有可能留着东西。
 *
 * 只要角色存在就当「可能有」：往云端写状态的路不止面板那几条——全局即时对话开着时，
 * **从没打开过 2.0 面板的角色**（activeMsg2Config 缺失，只是跟随全局默认开）每轮聊天
 * 也在经 POST /instant-chat 往 client_state 写完整对话和提示词（worker 侧还会写
 * chat_outbox / chat_fail）。按「配没配过」猜写没写过，猜漏一条路聊天原文就永久留在
 * D1 里。清理是幂等操作、成本一次网络请求，宁可多发不可漏，所以这里不做任何按角色的
 * capability 预检；真正的门只有一道——「压根没配 worker 连接」，那一道由调用方
 * （purgeCharCloudState、deleteCharacter 的前置检查）读全局配置来把。
 */
export const charMayHaveCloudState = (char: CharacterProfile | undefined): boolean =>
  Boolean(char);

/**
 * 清掉该角色的云端 client_state。永远不抛错（见文件头：不能阻塞角色删除）。
 *
 * 发请求之前先确认真有个 worker 可发。没填地址时云端一个字节都没写过，
 * 那不是「清理失败」，跳过就好——报成失败会让用户对着一条根本不存在的残留发愁。
 * 这也是唯一的一道门：只要 worker 配置在，就不再按角色猜「写没写过」，清一次是幂等的。
 *
 * 判断放在发请求之前、而不是靠 catch 里认错误文案：错误文案改一次这里就失效了。
 */
export const purgeCharCloudState = async (
  char: CharacterProfile | undefined,
): Promise<CharCloudStateCleanup> => {
  if (!charMayHaveCloudState(char)) return { status: 'skipped' };

  try {
    const globalConfig = await ActiveMsgStore.getGlobalConfig();
    if (!globalConfig.workerUrl?.trim()) return { status: 'skipped' };
  } catch {
    // 连本地配置都读不到，等于无从判断有没有云端；按没有处理，别为它弹错误。
    return { status: 'skipped' };
  }

  // 这个角色名下登记的 API 凭据行也一起清掉：角色都没了，那几行再留着只是白占
  // 云端的行数上限。跟 client_state 各清各的——凭据没清成不该让上下文也留在云端。
  // 失败只 warn：删角色的路上一个附带清理拦不住主线（下次同名 credId 覆盖即可）。
  try {
    await ActiveMsgClient.deleteLlmCredentials({ credIds: charCredIds(char!.id) });
  } catch (error) {
    console.warn('[Amsg2CharCleanup] 删角色时清云端 API 凭据失败（不影响删除）', error);
    // 本地那本指纹底账照划：角色都没了，留着几条死账只会一直占 localStorage，
    // 后台重传也会一遍遍去查一个不存在的角色。
    forgetCredIds(charCredIds(char!.id));
  }

  // 后台任务的一次性输入不住在角色命名空间里（它按 job 编号存在共用的 amsg:job 下，
  // 见 amsgTaskKinds），所以上面那趟清不到它。里面装的是这个角色的门牌全文、蒸馏材料
  // 和身份上下文——正是删除确认框承诺会清掉的那类东西，不能让它躺满 3 天等 TTL。
  await purgeInFlightPlateJob(char!.id);

  try {
    const keys = await ActiveMsgClient.clearCharClientState(char!.id);
    return { status: 'cleared', keys };
  } catch (error) {
    return { status: 'failed', error };
  }
};

/**
 * 清掉这个角色那份还在云端跑的门牌整理：把任务取消掉，再撤掉它的一次性输入。
 *
 * 只清「在飞」那一条：跑完的 worker 自己会删，而同一角色同时只许一份在飞（见
 * roomPlateCloud 的在飞记号），所以本地记着的那个 job 编号就是全部。
 *
 * 读记号要用**不看 TTL 的那个**（readPlateJobInFlightRaw）。带 TTL 的那个问的是
 * 「这份还算不算在飞」，超过半小时一律回 null——而躺得越久的那份越是没人管的：worker
 * 没送回结果、行还在云端占着，那行里装的是整块门牌原文、蒸馏材料和身份上下文，会一直
 * 留到 TTL 到期。删角色时的承诺是「记忆将被清空」，不能因为它躺久了就跳过。
 *
 * **先取消任务，再撤输入**。只撤输入的话任务行还在，到点照样起跑、照样按重试梯子重来
 * 几轮（读到空值会安静跳过，但每一轮都是一次调度），而它已经没有任何落脚点了。取消是
 * 幂等的：一次性任务跑完就删行，远端回 404 就是取消要达到的终态。
 *
 * 撤输入跟别的清理一样是**写空串**而不是删行（HTTP 的 PUT /client-state 没有删除语义）。
 */
const purgeInFlightPlateJob = async (charId: string): Promise<void> => {
  try {
    const { readPlateJobInFlightRaw, clearPlateJobInFlight, clearPlateJobDone } =
      await import('./memoryPalace/roomPlateCloud');
    const inFlight = readPlateJobInFlightRaw(charId);
    // 本地记号先清：云端那步失败也不该让这个已经不存在的角色继续占着闸。
    // 「哪些结果已经落过地」那本底账一起清掉——角色都没了，留着只是一串没主的编号。
    clearPlateJobInFlight(charId);
    clearPlateJobDone(charId);
    if (!inFlight) return;

    // 记号一清，那个 job 编号就再没有别的地方记着了——「设置 → API 调用记录」里那笔
    // 「云端生成中」于是永远等不到人来收，一直转圈到 5 天后被裁掉。在飞记号超时那条路
    // 特意绕开的就是这个坑，删角色这条路同样得收。
    const { cloudApiCallLogId, settleCloudApiCall } = await import('./apiCallLog');
    settleCloudApiCall({ id: cloudApiCallLogId(inFlight.jobId), ok: false });

    // 任务行先撤。拿不到 uuid 的只有一种情况：提交的答复丢在了路上（任务可能建了、编号
    // 却没回来），那种只能等它自己跑完——读到空输入会安静跳过。
    if (inFlight.uuid) {
      try {
        await ActiveMsgClient.cancelTask(inFlight.uuid);
      } catch (error) {
        console.warn('[Amsg2CharCleanup] 删角色时取消门牌整理任务失败（输入照撤）', error);
      }
    }

    const { AMSG_JOB_NAMESPACE } = await import('./amsgTaskKinds');
    const { plateJobKey } = await import('./amsgPlateJob');
    await ActiveMsgClient.clearClientStateValue(AMSG_JOB_NAMESPACE, plateJobKey(inFlight.jobId));
  } catch (error) {
    console.warn('[Amsg2CharCleanup] 删角色时清在飞的门牌整理输入失败（等 TTL 兜底）', error);
  }
};
