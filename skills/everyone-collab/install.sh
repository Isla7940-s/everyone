#!/usr/bin/env bash
# Everyone 跨端协同 —— 标准 Skill + CLI 安装器（跨端协同.md §三）
# 用各工具官方支持的标准安装方式：
#   Cursor       ~/.cursor/skills/everyone-collab/SKILL.md
#   Claude Code  ~/.claude/skills/everyone-collab/SKILL.md
#   Codex        ~/.codex/AGENTS.md 追加引用（幂等）
#   CLI          ~/.everyone/everyone.mjs
#
# 用法：
#   BASE_URL=http://<everyone服务器>:8902 bash install.sh          # 从服务器拉取
#   bash install.sh /path/to/repo                                  # 从本地仓库拷贝

set -euo pipefail

BASE_URL="${BASE_URL:-}"
REPO_DIR="${1:-}"

fetch() { # fetch <kit名> <目标文件>
  if [ -n "$REPO_DIR" ]; then
    case "$1" in
      skill) cp "$REPO_DIR/skills/everyone-collab/SKILL.md" "$2" ;;
      cli) cp "$REPO_DIR/cli/everyone.mjs" "$2" ;;
    esac
  elif [ -n "$BASE_URL" ]; then
    curl -fsSL "$BASE_URL/api/collab/kit/$1" -o "$2"
  else
    echo "用法：BASE_URL=http://<服务器>:8902 bash install.sh   或   bash install.sh /path/to/everyone-repo" >&2
    exit 1
  fi
}

echo "== Everyone 跨端协同安装 =="

# 1. CLI
mkdir -p "$HOME/.everyone"
fetch cli "$HOME/.everyone/everyone.mjs"
chmod +x "$HOME/.everyone/everyone.mjs"
echo "✓ CLI → ~/.everyone/everyone.mjs"

# 2. Skill → Cursor / Claude Code（标准 skills 目录）
for dir in "$HOME/.cursor/skills/everyone-collab" "$HOME/.claude/skills/everyone-collab"; do
  mkdir -p "$dir"
  fetch skill "$dir/SKILL.md"
done
echo "✓ Skill → ~/.cursor/skills/everyone-collab/SKILL.md"
echo "✓ Skill → ~/.claude/skills/everyone-collab/SKILL.md"

# 3. Codex：官方机制是 ~/.codex/AGENTS.md，追加引用（幂等）
mkdir -p "$HOME/.codex/skills/everyone-collab"
fetch skill "$HOME/.codex/skills/everyone-collab/SKILL.md"
MARKER="<!-- everyone-collab-skill -->"
AGENTS="$HOME/.codex/AGENTS.md"
if [ ! -f "$AGENTS" ] || ! grep -q "$MARKER" "$AGENTS"; then
  {
    echo ""
    echo "$MARKER"
    echo "## Everyone 跨端协同"
    echo ""
    echo "涉及 Everyone 工作总结 / 任务完成 / 时间去向 / 远程协作时，先读并遵循 ~/.codex/skills/everyone-collab/SKILL.md。"
  } >> "$AGENTS"
fi
echo "✓ Skill → ~/.codex/skills/everyone-collab/SKILL.md（AGENTS.md 已挂引用）"

# 4. 可选：node 别名提示
cat <<'EOF'

安装完成。接下来：
  1. 在 Everyone 后台「跨端协同」页生成个人 token
  2. node ~/.everyone/everyone.mjs auth login --base-url http://<服务器>:8902 --token ct_xxx
  3. （可选）加 shell 别名：alias everyone='node ~/.everyone/everyone.mjs'
  4. 本地客户端（处理云端远程求助）：
     curl -fsSL <服务器>/api/collab/kit/client -o ~/.everyone/everyone_local_client.py
     python3 ~/.everyone/everyone_local_client.py init --base-url http://<服务器>:8902 --token ct_xxx
     python3 ~/.everyone/everyone_local_client.py run
EOF
