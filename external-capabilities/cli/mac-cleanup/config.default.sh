# mac-cleanup 默认配置（可提交）
#
# 本机覆盖写在 config.local.sh —— 由 ./mac-cleanup.sh --init 生成，不要提交。
# 加载顺序：本文件 → config.local.sh（后者覆盖前者）

## mo 可执行文件。留空 = 自动探测（PATH → /opt/homebrew/bin → /usr/local/bin → ~/.local/bin）
MC_MO_BIN="${MC_MO_BIN:-}"

## launchd 标签。每台机器要唯一；同一用户域内不能重复。
## 默认值不含用户名，所以「每人自己机器上一份」不会撞；
## 若同一台机器上要给多个用户装，改成 local.<用户名>.mac-cleanup
MC_LABEL="${MC_LABEL:-local.mac-cleanup}"

## 季度触发的「日」（1-28）。月份固定为 1/4/7/10。
## 想锚定到"安装那天"，改成 `date +%d` 的结果即可（比如 20 = 每季度 20 日）。
MC_SCHEDULE_DAY="${MC_SCHEDULE_DAY:-1}"

## 报告与运行产物目录
MC_REPORT_DIR="${HOME}/Library/Logs/mac-cleanup"

## DSH 相关检查（--init 探测后写入 config.local.sh；留空 = 跳过这些检查）
## MC_DSH_RUNTIME  : 支撑 ~/.dsh/profiles/node_modules 符号链接的 npx 目录
## MC_DSH_HOME     : ~/.dsh 本身
## 非 DSH 用户不需要填，健康检查会自动 SKIP。
