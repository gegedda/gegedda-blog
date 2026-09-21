#!/usr/bin/env bash
# 停掉 wrangler dev 并清干净它留下的孤儿进程。
#
# 为什么需要这个脚本：`TaskStop`（以及任何只 kill 外层 shell 的做法）只杀掉
# 包装它的那层进程。真正的 wrangler / workerd 会活下来并**占着 dist/client**，
# 于是下一次 `astro build` 会在 Astro 的 emptyDir() 里报
#
#     EPERM, Permission denied: ...\blog\dist\client
#
# 而且失败发生在 dist/server 被清掉之后——留在盘上的是**上一次**构建的产物。
# 表现就是：源码改了、构建"看着像成功了"、线上行为一点没变。这个坑已经踩过一次
# （feed.xml 的 `<content:encoded/>` 一直是空的，追了半天以为是构建缓存）。
#
# 只杀 workerd 和命令行里带 wrangler 的 node，
# 绝不 `taskkill /IM node.exe` —— VSCode 和本工具本身都是 node 进程。

set -uo pipefail

echo "== 停掉 wrangler dev =="

# workerd 只会由 wrangler dev 起，直接按名字杀是安全的
taskkill //F //IM workerd.exe 2>/dev/null | head -5 || echo "  (没有 workerd)"

# 剩下的 node 进程按命令行筛，避免误伤
powershell -NoProfile -Command "
  Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |
  Where-Object { \$_.CommandLine -like '*wrangler*' } |
  ForEach-Object {
    Write-Output ('  kill ' + \$_.ProcessId)
    Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue
  }
" 2>/dev/null

sleep 2

# 真正的判据：dist 删得掉，就说明没有残留的句柄
if rm -rf dist 2>/dev/null; then
  echo "== dist 已清理 =="
else
  echo "!! dist 删不掉，还有进程占着。手动查："
  echo "   powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter \\\"Name='node.exe'\\\" | Select ProcessId,CommandLine\""
  exit 1
fi
