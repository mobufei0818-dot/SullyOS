#!/usr/bin/env bash
# /opt/umami/bin/audit-entry.sh
#
# GitHub Actions 那把审计钥匙唯一能触达的东西。
#
# 链路：
#   CI: ssh audit@stats.friedsully.com "<GITHUB_RUN_ID>"
#   → authorized_keys 里的 restrict,command= 把请求的命令整个丢掉，
#     原文塞进 SSH_ORIGINAL_COMMAND，然后无条件执行本脚本
#   → sudoers 只允许 audit 免密跑这一个脚本（audit 自己没有 docker 权限、
#     不在任何特权组，拿到它的 shell 也做不了什么）
#   → 本脚本校验 nonce，转交 assert-privacy.sh
#
# ⚠️ SSH_ORIGINAL_COMMAND 的内容 100% 由客户端控制，而且这里是 root 上下文。
# 钥匙泄露的场景下，这个变量就是攻击者手上唯一的输入 —— 它下游会被拼进
# SQL 字符串（事件名 ci_probe_<nonce>）。所以下面三道校验一道都不能省，
# 也不要"顺手"改成接受连字符、字母或者别的什么格式再说。
# 想传别的参数进来的话，正确做法是在这里新增一个固定的、不含用户输入的分支。

set -uo pipefail
umask 077

log() { printf '%s\n' "$*" >&2; }

reject() {
  log "拒绝：$1"
  logger -t umami-audit -p user.warning "审计入口拒绝请求：$1（原文长度 ${#raw}）"
  exit 2
}

raw="${SSH_ORIGINAL_COMMAND:-}"

# ── 校验 1：长度。先卡长度，避免把超长垃圾喂给后面的匹配和日志。
(( ${#raw} >= 1 && ${#raw} <= 24 )) || reject "长度不合法"

# ── 校验 2：case 通配。含任意一个非 0-9 的字符（包括换行、空格、引号、
#    分号、反引号）就出局。这条比正则更不容易出岔子：它逐字符看整个字符串，
#    不涉及任何锚定语义。
case "$raw" in
  ''|*[!0-9]*) reject "含非数字字符" ;;
esac

# ── 校验 3：正则复核。bash 的 =~ 里 ^ $ 锚定的是整个字符串而不是行，
#    和上面那条是互相独立的两种实现，一起用是故意的。
[[ "$raw" =~ ^[0-9]+$ ]] || reject "正则复核未通过"

nonce="$raw"
logger -t umami-audit -p user.info "审计入口接受 nonce=$nonce"

echo "===== AUDIT-BEGIN nonce=$nonce $(date -u +%FT%TZ) ====="

/opt/umami/bin/assert-privacy.sh "$nonce"
rc=$?

echo "===== AUDIT-END rc=$rc ====="

# ── schema 账本（第三档）。只输出，不判断。CI 那边拿它和仓库里存的
#    infra/umami-schema.sql 比一下，不一样就把 diff 报出来让人看。
#    刻意不让 CI 自己 commit 回仓库：master 要求走 PR，bot 直推会被规则弹回来，
#    而且账本留在 Actions 历史里（90 天）目前就够用了。
#
#    那两条 grep 不是洁癖：pg_dump 17 会在开头插一行
#      \restrict <每次都不同的随机 token>
#    （17.6 引入，防 psql 元命令注入）。不滤掉的话每天的 dump 都不一样，
#    第三档就变成每天往仓库灌一次无意义的 commit —— 正是不想要的那个结果。
#    除此之外 pg_dump 的输出不含时间戳，所以滤完之后 schema 没动的日子
#    是逐字节相同的。
echo "===== SCHEMA-BEGIN ====="
docker compose -f /opt/umami/docker-compose.yml exec -T db \
  pg_dump -U umami -d umami --schema-only --no-owner --no-privileges < /dev/null \
  | grep -v '^\\restrict ' | grep -v '^\\unrestrict '
echo "===== SCHEMA-END ====="

exit "$rc"
