# SullyOS 朋友圈 Worker 路由模块（阶段 4）

朋友圈不会再部署第二个 Worker。这个目录是挂载到现有主动消息 2.0 Worker 的独立路由模块：
`worker/amsg/src/index.ts` 只把 `/moments/*` 交给本模块，原版 AMSG 的任务、Cron、推送、
加密和聊天生成流程保持不变。

## 正式部署方式（复用已有 AMSG Worker）

1. 在本地项目根目录构建 Worker bundle：

   ```bash
   pnpm run build:workers
   ```

2. 打开你已经在用的 Cloudflare AMSG Worker（例如 `sullyos-amsg`）Dashboard → **Edit code**。
   用项目生成的 `worker/amsg/worker.bundle.js` 全选替换现有代码，然后点击 **Deploy**。

3. 保留原来的设置，不要新建第二个 Worker、第二个 URL、第二个 D1 或第二套密钥：
   - D1 binding 仍是 `DB`，朋友圈表会在这个已有数据库中按 `CREATE TABLE IF NOT EXISTS` 自动建立；
   - `AMSG_SERVER_TOKEN` 仍是主动消息 2.0 的共享密钥，朋友圈请求复用它的 `X-Client-Token`；
   - 原有 AMSG_MASTER_KEY、VAPID、Cron、Durable Object 和推送凭据都保持不变。

4. 小手机的“主动消息 2.0”设置仍是 Worker 地址、用户 ID 和共享密钥的唯一来源。朋友圈设置只读显示
   “复用主动消息 2.0 Worker”，不需要再次填写或保存这些值。重新打开朋友圈或点击“重新读取配置”即可读取。

本模块不是原版仓库的一部分；它只存在于用户的二改 fork 中。上游 `qegj567-cloud/SullyOS`
目前没有 `worker/moments` 或 `/moments` 路由。同步原版时保留这个 fork-only wrapper，不覆盖上游的
主动消息入口。

## 路由

实际部署后路径带 `/moments` 前缀：

- `GET /moments/health`：健康检查；
- `POST /moments/runtime`：同步加密角色生活线快照、发帖/互动档位和低价模型凭据引用；
- `POST /moments/sync`：幂等上传本地朋友圈事件、互动任务和收据；
- `GET /moments/deliveries?userId=...` / `POST /moments/deliveries/ack`：拉取并确认离线生成的事实；
- `GET /moments/tasks?userId=...&dueBefore=...`：读取到期任务；
- `POST /moments/tasks/claim`：原子认领一条到期任务；
- `POST /moments/tasks/complete`：报告任务完成、失败、取消或重新排队；
- `GET /moments/diagnostics?userId=...`：查看任务计数和最近诊断。

`utils/momentsSync.ts` 已使用这些带前缀的路径，并发送 `X-Client-Token`。OPTIONS 预检同时兼容
`X-Client-Token` 与旧的 `X-Moments-Token`。

## 数据与职责边界

- 朋友圈使用同一个 `DB`，但业务事实只写 `moments_*` 表，不混写 AMSG 任务表；模型凭据仅复用
  原版主动消息 2.0 的 `llm_credentials` 加密行，朋友圈表只保存 `moments/default` 引用；
- AMSG Cron 仍每分钟运行以保证原版消息准时；朋友圈模块排在原版 AMSG 投递之后，并且只有整 15 分钟
  才查询自己的到期索引，每轮最多判断一名主体；卡住任务的恢复降为每小时一次；
- 到期主体只调用一次低价模型完成“发不发 + 正文 + 相册/80%照片占位 + 可见范围”。只有确实发帖时，
  再用一次统一调用规划所有正式角色、明确 NPC、2–5 位随机路人的点赞/评论/相互回复，不逐人调用模型；
- Worker 会优先读取主动消息 2.0 的最新 `fire_pack` 私聊上下文；没有时回落到朋友圈加密快照。
  页面关闭后仍可生成和安排互动，重新打开朋友圈只负责拉取事实并写入本地 IndexedDB；
- 旧的页面内十分钟规划仅保留为“未启用离线模式”的兼容路径；启用离线模式后由 Worker 独占判断，避免双发；
- 阶段 5 的醋意强制主动消息仍走现有关系层/AMSG 链路，不由本模块伪造消息。

## 文件说明

- `src/index.ts`：被现有 AMSG 入口 import 的路由实现；
- `schema.sql`：四张 `moments_*` 表的可选手动建表脚本；正式挂载时 Worker 会自动幂等建表；
- `worker.bundle.js`：本模块的独立预览/测试 bundle。它不是当前正式部署要替换的文件；正式部署应替换
  `worker/amsg/worker.bundle.js`，这样才能同时保留原版 AMSG；
- `wrangler.toml`：保留作本地独立调试模板，不代表需要为朋友圈新建 Cloudflare 服务。

## 独立本地调试（可选）

如需单独测试本模块，可以使用 `worker/moments/worker.bundle.js` 和 `wrangler.toml`，但不要把这个
独立测试服务的 URL 填入正式小手机。正式版本始终使用已有 AMSG Worker 的 `/moments/*` 路由。
