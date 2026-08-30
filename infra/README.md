# infra/ — 统计服务器的配置基线

这里放的是自托管 umami 实例（`stats.friedsully.com`）上那几个**决定隐私承诺成不成立**的文件的副本。
它们不参与前端构建，只有一个用途：给 [`.github/workflows/privacy-audit.yml`](../.github/workflows/privacy-audit.yml)
当比对基线。

承诺本身写在 [`docs/analytics.md`](../docs/analytics.md)，这里是「怎么保证它没被悄悄改掉」。

| 文件 | 线上位置 | 说明 |
|---|---|---|
| `Caddyfile` | `/etc/caddy/Caddyfile` | IP 截断（v4 → /24、v6 → /48）、清掉十几个可伪造的真实-IP 头和 CDN 地理头、日志全部 discard |
| `docker-compose.yml` | `/opt/umami/docker-compose.yml` | `PRIVATE_MODE` / `DISABLE_TELEMETRY` / `DISABLE_UPDATES`、`CLIENT_IP_HEADER=X-Anon-IP`、db 服务下**没有** `ports:` |
| `assert-privacy.sh` | `/opt/umami/bin/assert-privacy.sh` | 每日自检本体，把承诺逐条变成 SQL / HTTP 断言 |
| `audit-entry.sh` | `/opt/umami/bin/audit-entry.sh` | CI 那把钥匙唯一能触达的入口，只收一个数字 nonce |
| `umami-privacy-trigger.expected.txt` | 数据库里 | geo 触发器的规范化定义（postgres 自己吐的，不是手写 SQL） |
| `umami-schema.sql` | 数据库里 | `pg_dump --schema-only` 的账本，schema 变了 CI 会报 diff（不自动提交，见下） |
| `known_hosts` | — | 服务器主机指纹，钉死用的 |

## 判定为什么放在仓库这边

服务器只做一件事：报出自己那几个文件的 sha256（`assert-privacy.sh` 输出的 `CONFIG-SHA256` 行）。
**比对发生在 GitHub Actions 里**，基线是这个目录。

这样安排是因为，让服务器自己判断「我有没有被改过」是没有意义的 —— 能改配置的人当然也能改那个判断。
拆成两边之后，想让一次配置漂移不被发现，就得同时改服务器和这个仓库，而这两处留下的痕迹是分开的、
且仓库那份有 git 历史。

同理，`assert-privacy.sh` 里那几行 `CONFIG-SHA256` 不是防篡改措施，只是「报事实」。

## 改了线上配置怎么办

**先改线上，再把文件同步到这里，一起提交。** 顺序反过来也行，但两边必须在同一天对上 ——
CI 每天比一次，对不上就是红的，而红的原因只会写「线上 X 与仓库副本不一致」，
不会告诉你哪边才是对的那个。所以 commit message 里写清楚改了什么、为什么。

`umami-privacy-trigger.expected.txt` 不要手写，用数据库的输出：

```bash
docker compose -f /opt/umami/docker-compose.yml exec -T db psql -U umami -d umami -qtAX \
  -c "SELECT pg_get_functiondef('umami_strip_geo'::regproc);" < /dev/null
docker compose -f /opt/umami/docker-compose.yml exec -T db psql -U umami -d umami -qtAX \
  -c "SELECT pg_get_triggerdef(oid) FROM pg_trigger
      WHERE tgname='trg_umami_strip_geo' AND NOT tgisinternal;" < /dev/null
```

（两条输出拼起来、删空行。手写的 SQL 和 postgres 回吐的定义在空白和 schema 限定上对不上，逐字比对必然失败。）

`umami-schema.sql` 平时不用管。schema 一旦变了（umami 升级加了表 / 加了列之类），
CI 会红一次，并在 run summary 里贴出 diff —— **新增的表和列正是「多了个能存敏感数据的地方」
最可能的样子**，所以这里刻意让它红而不是静默通过。

确认无害之后，从那次 run 的 `umami-schema` artifact 里把新版下下来，覆盖 `infra/umami-schema.sql`
提交一次，下一轮就恢复绿。

CI 不会自己提交这个文件：master 要求走 PR，bot 直推会被分支保护弹回来（GH013），
而且红的原因会变成「推不上去」这种跟隐私毫无关系的东西。账本留在 artifact（90 天）
和 Actions 历史里，目前够用。

## 换服务器 / 换域名了

重新生成 `known_hosts`：

```bash
ssh-keyscan -t ed25519,rsa,ecdsa <新域名> | sort > infra/known_hosts
```

审计钥匙也要重来一把（`ssh-keygen -t ed25519`，私钥进仓库 secret `AUDIT_SSH_KEY`，
公钥进服务器 `audit` 用户的 `authorized_keys`，前缀是
`restrict,command="/usr/bin/sudo -n /opt/umami/bin/audit-entry.sh"`）。
别拿任何一把已有的登录钥匙来凑。
