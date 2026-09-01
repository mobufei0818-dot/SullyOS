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
- `POST /moments/sync`：幂等上传本地朋友圈事件、互动任务和收据；
- `GET /moments/tasks?userId=...&dueBefore=...`：读取到期任务；
- `POST /moments/tasks/claim`：原子认领一条到期任务；
- `POST /moments/tasks/complete`：报告任务完成、失败、取消或重新排队；
- `GET /moments/diagnostics?userId=...`：查看任务计数和最近诊断。

`utils/momentsSync.ts` 已使用这些带前缀的路径，并发送 `X-Client-Token`。OPTIONS 预检同时兼容
`X-Client-Token` 与旧的 `X-Moments-Token`。

## 数据与职责边界

- 朋友圈使用同一个 `DB`，但只创建 `moments_relationship_events`、`moments_tasks`、
  `moments_sync_receipts`、`moments_diagnostics` 四张独立表，不混写 AMSG 核心表；
- Worker 只保存结构化事件/任务摘要、幂等键和诊断，不接触朋友圈副 API Key，也不直接调用聊天模型；
- 朋友圈打开时由本地执行器拉回并落地互动；Worker Cron 只每分钟回收卡住的 running 任务；
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
