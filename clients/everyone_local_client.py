#!/usr/bin/env python3
"""Everyone 本地客户端（跨端协同.md §十/§十一/§十二）——第一版：单个 Python 文件，仅标准库。

职责：
  - 与 Everyone 云端轮询通信，接收云端 Agent 发来的远程求助；
  - 维护「会话 ID → 本地原始会话位置」映射（与 Everyone CLI 共用 ~/.everyone/session-map.json）；
  - 为每次求助创建独立临时沙箱：工作目录快照 + 完整原始会话 + 任务书 + 沙箱 CLI + 沙箱 Skill；
  - 启动本地 Codex（或内置 mock 引擎）完成工作；
  - 监听执行结果，兜底上传回复/失败信息，把结果关联回原始求助。

用法：
  python3 everyone_local_client.py init --base-url http://<服务器>:8902 --token ct_xxx [--engine codex|mock]
  python3 everyone_local_client.py status
  python3 everyone_local_client.py scan [--tool codex|claude-code|cursor]     # 列出授权工具的候选会话文件
  python3 everyone_local_client.py map add <会话ID> --tool codex --path <会话文件> [--workspace 项目目录]
  python3 everyone_local_client.py map list
  python3 everyone_local_client.py run [--once] [--interval 10]               # 轮询处理远程求助
"""

from __future__ import annotations

import argparse
import base64
import glob
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

HOME = Path.home() / ".everyone"
CONFIG_FILE = HOME / "client.json"
CLI_CONFIG_FILE = HOME / "config.json"        # Everyone CLI 的配置（token 可复用）
MAP_FILE = HOME / "session-map.json"          # 会话 ID → 本地原始位置（与 CLI 共用）
SANDBOXES_DIR = HOME / "sandboxes"

DEFAULT_CONFIG = {
    "base_url": "",
    "token": "",
    "poll_interval_sec": 10,
    "engine": "codex",                         # codex | mock
    # 说明：--skip-git-repo-check（沙箱不是 git 仓库）；workspace-write + 放行网络（沙箱 CLI 要回传结果）
    "codex_cmd": [
        "codex", "exec", "--sandbox", "workspace-write",
        "-c", "sandbox_workspace_write.network_access=true",
        "--skip-git-repo-check", "--cd", "{sandbox}", "{prompt}",
    ],
    "engine_timeout_sec": 900,
    "allowed_tools": ["codex", "cursor", "claude-code"],   # 用户授权可读取的工具（§三）
    "allowed_workspaces": [],                  # 空 = 不限制；否则快照/扫描只允许这些目录
    "snapshot_max_file_mb": 5,
    "snapshot_max_total_mb": 200,
    "remote_help_enabled": True,               # 用户授权本地客户端执行远程协作任务
}

# 各工具默认会话记录位置（§一）——扫描仅在用户授权的工具范围内进行
TOOL_SESSION_GLOBS = {
    "codex": ["~/.codex/sessions/**/*.jsonl"],
    "claude-code": ["~/.claude/projects/*/*.jsonl"],
    "cursor": ["~/.cursor/projects/*/agent-transcripts/*.jsonl"],
}

SNAPSHOT_IGNORES = {
    ".git", "node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build",
    "out", ".DS_Store", ".cache", "target", ".pnpm-store",
}


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return fallback


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(read_json(CONFIG_FILE, {}))
    # token/base_url 缺失时借用 CLI 的配置
    cli_cfg = read_json(CLI_CONFIG_FILE, {})
    cfg["base_url"] = (os.environ.get("EVERYONE_BASE_URL") or cfg["base_url"] or cli_cfg.get("baseUrl", "")).rstrip("/")
    cfg["token"] = os.environ.get("EVERYONE_TOKEN") or cfg["token"] or cli_cfg.get("token", "")
    return cfg


class ApiError(Exception):
    pass


def api(cfg: dict, method: str, path: str, body=None, token: str | None = None):
    url = f"{cfg['base_url']}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token or cfg['token']}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode()).get("error", "")
        except Exception:
            detail = ""
        raise ApiError(f"HTTP {e.code} {path}：{detail}") from None
    except urllib.error.URLError as e:
        raise ApiError(f"连不上 Everyone 云端（{cfg['base_url']}）：{e.reason}") from None


def fetch_kit(cfg: dict, name: str) -> str:
    """从云端拉分发件（沙箱 CLI / 沙箱 Skill），保持与服务端版本一致。"""
    req = urllib.request.Request(f"{cfg['base_url']}/api/collab/kit/{name}")
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read().decode()


# ===== init / status / scan / map =====

def cmd_init(args) -> None:
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(read_json(CONFIG_FILE, {}))
    if args.base_url:
        cfg["base_url"] = args.base_url.rstrip("/")
    if args.token:
        cfg["token"] = args.token
    if args.engine:
        cfg["engine"] = args.engine
    if not cfg["base_url"] or not cfg["token"]:
        sys.exit("✗ 需要 --base-url 与 --token（token 在 Everyone 后台「跨端协同」页生成）")
    who = api(cfg, "GET", "/api/collab/whoami")
    write_json(CONFIG_FILE, cfg)
    log(f"✓ 已连接：{who.get('name')}（{who.get('personId')}）· 配置写入 {CONFIG_FILE}")
    log("提示：授权范围（allowed_tools / allowed_workspaces / remote_help_enabled）可在该文件里调整")


def cmd_status(args) -> None:
    cfg = load_config()
    if not cfg["base_url"] or not cfg["token"]:
        sys.exit("✗ 未配置，先运行 init")
    who = api(cfg, "GET", "/api/collab/whoami")
    mapping = read_json(MAP_FILE, {})
    pending = api(cfg, "GET", "/api/collab/help/pending")["helps"]
    log(f"身份：{who.get('name')}（{who.get('personId')}）· {cfg['base_url']}")
    log(f"引擎：{cfg['engine']} · 轮询 {cfg['poll_interval_sec']}s · 远程协作 {'已授权' if cfg['remote_help_enabled'] else '未授权'}")
    log(f"授权工具：{'、'.join(cfg['allowed_tools']) or '（无）'}")
    log(f"会话映射：{len(mapping)} 条（{MAP_FILE}）")
    log(f"待处理求助：{len(pending)} 个")


def cmd_scan(args) -> None:
    cfg = load_config()
    tools = [args.tool] if args.tool else cfg["allowed_tools"]
    found = 0
    for tool in tools:
        if tool not in TOOL_SESSION_GLOBS:
            log(f"! 不认识的工具：{tool}")
            continue
        if tool not in cfg["allowed_tools"]:
            log(f"! 跳过未授权工具：{tool}")
            continue
        print(f"== {tool} ==")
        for pattern in TOOL_SESSION_GLOBS[tool]:
            for f in sorted(glob.glob(os.path.expanduser(pattern), recursive=True))[-30:]:
                st = os.stat(f)
                print(f"  {datetime.fromtimestamp(st.st_mtime).strftime('%m-%d %H:%M')}  {f}")
                found += 1
    print(f"\n共 {found} 个候选会话文件。上传总结并登记映射：")
    print('  node ~/.everyone/everyone.mjs sessions upload --tool <工具> ... --local-path <文件>')


def cmd_map(args) -> None:
    mapping = read_json(MAP_FILE, {})
    if args.map_action == "list":
        if not mapping:
            print("（映射为空）")
            return
        for sid, m in mapping.items():
            print(f"[{sid}] {m.get('tool')} · {m.get('path')}")
        return
    # add
    sid = args.session_id.upper()
    if len(sid) != 16 or not sid.isalnum():
        sys.exit("✗ 会话 ID 必须是 16 位字母数字")
    p = Path(args.path).expanduser().resolve()
    if not p.exists():
        sys.exit(f"✗ 会话文件不存在：{p}")
    now = datetime.now().astimezone().isoformat()
    mapping[sid] = {
        "tool": args.tool,
        "workspace": str(Path(args.workspace).expanduser().resolve()) if args.workspace else str(p.parent),
        "path": str(p),
        "createdAt": mapping.get(sid, {}).get("createdAt", now),
        "updatedAt": now,
    }
    write_json(MAP_FILE, mapping)
    log(f"✓ 映射已登记：[{sid}] → {p}")


# ===== 沙箱构建（§十二）=====

def snapshot_workspace(src: Path, dest: Path, cfg: dict) -> str:
    """快照原工作目录：跳过重目录/超大文件，总量封顶。返回快照说明。"""
    if not src.exists() or not src.is_dir():
        dest.mkdir(parents=True, exist_ok=True)
        return f"原工作目录 {src} 不存在，快照为空。"
    allowed = cfg.get("allowed_workspaces") or []
    if allowed and not any(str(src).startswith(str(Path(a).expanduser().resolve())) for a in allowed):
        dest.mkdir(parents=True, exist_ok=True)
        return f"原工作目录 {src} 不在用户授权范围（allowed_workspaces）内，未快照。"
    max_file = cfg["snapshot_max_file_mb"] * 1024 * 1024
    max_total = cfg["snapshot_max_total_mb"] * 1024 * 1024
    total = 0
    copied = 0
    skipped = 0
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in SNAPSHOT_IGNORES and not d.startswith(".env")]
        rel_root = Path(root).relative_to(src)
        for name in files:
            if name in SNAPSHOT_IGNORES or name == ".env":
                continue
            fsrc = Path(root) / name
            try:
                size = fsrc.stat().st_size
            except OSError:
                continue
            if size > max_file or total + size > max_total:
                skipped += 1
                continue
            fdst = dest / rel_root / name
            fdst.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.copy2(fsrc, fdst)
            except OSError:
                skipped += 1
                continue
            total += size
            copied += 1
    return (f"快照自 {src}：{copied} 个文件（{total / 1024 / 1024:.1f}MB）"
            f"{f'，跳过 {skipped} 个（超限/忽略规则）' if skipped else ''}。"
            f"已排除 .git/node_modules/.env 等；这是副本，放心修改。")


def build_help_md(help_obj: dict, mapping_entry: dict, snapshot_note: str, session_rel: str) -> str:
    """任务书（§十二）：背景、来源、会话、问题、期望、快照说明、CLI/Skill 用法、回复与附件要求。"""
    s = help_obj.get("session") or {}
    lines = [
        f"# 远程求助任务书（{help_obj['id']}）",
        "",
        "你是用户本地的 Codex Agent。Everyone 云端的一个 Agent 在替团队干活时缺少上下文，",
        "指名求助这段发生在本机的历史工作会话。请基于原始会话与工作区快照完成求助，并用沙箱 CLI 提交结果。",
        "",
        "## 当前背景",
        "",
        help_obj.get("background") or "（云端未提供额外背景）",
        "",
        "## 求助来源",
        "",
        f"- 发起方：Everyone 云端 Agent（{help_obj.get('requesterLabel') or '未知会话'}）",
        f"- 创建时间：{help_obj.get('createdAt', '')}",
        "",
        "## 目标工作会话",
        "",
        f"- 会话 ID：{help_obj['sessionId']}",
        f"- 来源工具：{s.get('sourceTool') or mapping_entry.get('tool')}",
        f"- 大需求 / 子任务：{s.get('requirement', '?')} / {s.get('subtask', '?')}",
        f"- 短总结：{s.get('briefSummary', '（无）')}",
        f"- 详细总结：{s.get('detailSummary', '（无）')}",
        f"- 完整原始会话（云端没有，只有这里有）：`{session_rel}`",
        "",
        "## 求助问题",
        "",
        help_obj["question"],
        "",
        "## 期望你完成的内容",
        "",
        help_obj.get("expectation") or "回答上面的求助问题，给出结论与依据。",
    ]
    if help_obj.get("contextInfo"):
        lines += ["", "## 云端沙箱提供的补充信息", "", help_obj["contextInfo"]]
    lines += [
        "",
        "## 工作区快照说明",
        "",
        f"`workspace/` —— {snapshot_note}",
        "",
        "## CLI 与 Skill 的使用方式",
        "",
        "- 沙箱 Skill：`AGENTS.md`（本文件同级），先读它；",
        "- 沙箱 CLI：`node everyone.mjs ...`，只有两个命令：`help attach`（上传附件）、`help reply`（提交回复）；",
        "- 产出文件写到 `output/` 目录。",
        "",
        "## 回复要求",
        "",
        "- 直接回答求助问题：结论在前、依据在后，引用原始会话的关键内容时注明来自会话记录；",
        "- 云端 Agent 正阻塞等待你的文字回复，回复要能被它直接拿去继续工作；",
        "- 有文件产出（文档/补丁/数据）先 `node everyone.mjs help attach <文件>` 上传，再提交文字回复；",
        "- 完成：`node everyone.mjs help reply --file output/回复.md --note \"一句话完成说明\"`",
        "  或 `node everyone.mjs help reply --text \"…\" --note \"…\"`；",
        "- 确实无法完成：`node everyone.mjs help reply --failed --error \"原因\"`。",
        "",
        "reply 只能提交一次，提交前自查：是否直接回答了问题？依据是否来自原始会话/快照？附件是否已经 attach？",
    ]
    return "\n".join(lines)


def build_sandbox(cfg: dict, help_obj: dict, mapping_entry: dict, sandbox_token: str) -> Path:
    sandbox = SANDBOXES_DIR / help_obj["id"]
    if sandbox.exists():
        shutil.rmtree(sandbox)
    (sandbox / "output").mkdir(parents=True)
    (sandbox / "session").mkdir()

    # 1. 完整原始会话原样放入（§十）
    src_session = Path(mapping_entry["path"])
    session_rel = f"session/raw-session{src_session.suffix or '.txt'}"
    shutil.copy2(src_session, sandbox / session_rel)

    # 2. 工作目录快照
    snapshot_note = snapshot_workspace(Path(mapping_entry.get("workspace", src_session.parent)), sandbox / "workspace", cfg)

    # 3. Everyone CLI + 沙箱 Skill（从云端拉，保证版本一致）
    (sandbox / "everyone.mjs").write_text(fetch_kit(cfg, "cli"), "utf-8")
    skill = fetch_kit(cfg, "sandbox-skill")
    (sandbox / "AGENTS.md").write_text(skill, "utf-8")   # Codex 标准入口
    (sandbox / "SKILL.md").write_text(skill, "utf-8")

    # 4. 沙箱凭证（CLI 检测到它即进入「只能提交回复/上传附件」模式）
    write_json(sandbox / "everyone-sandbox.json", {
        "baseUrl": cfg["base_url"],
        "helpId": help_obj["id"],
        "helpToken": sandbox_token,
    })

    # 5. 任务书
    (sandbox / "HELP.md").write_text(build_help_md(help_obj, mapping_entry, snapshot_note, session_rel), "utf-8")
    return sandbox


# ===== 引擎 =====

def run_codex(cfg: dict, sandbox: Path) -> tuple[int, str]:
    prompt = (
        "读当前目录的 HELP.md（远程求助任务书），按要求完成工作。"
        "原始会话在 session/，工作区快照在 workspace/，产出写到 output/。"
        "最后必须用 `node everyone.mjs help reply ...` 提交回复（先 attach 附件再 reply）。"
    )
    cmd = [part.replace("{sandbox}", str(sandbox)).replace("{prompt}", prompt) for part in cfg["codex_cmd"]]
    log(f"启动本地 Codex：{' '.join(cmd[:3])} …")
    try:
        proc = subprocess.run(
            cmd, cwd=sandbox, capture_output=True, text=True, timeout=cfg["engine_timeout_sec"],
            stdin=subprocess.DEVNULL,  # codex exec 检测到管道 stdin 会挂起等输入
        )
        tail = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()[-4000:]
        return proc.returncode, tail
    except subprocess.TimeoutExpired:
        return -1, f"本地 Codex 超时（{cfg['engine_timeout_sec']}s）"
    except FileNotFoundError:
        return -2, f"找不到本地 Codex 可执行文件：{cfg['codex_cmd'][0]}（可在 {CONFIG_FILE} 里改 codex_cmd，或把 engine 设为 mock）"


def run_mock(cfg: dict, sandbox: Path, help_obj: dict) -> tuple[int, str]:
    """内置演示/测试引擎：不依赖 Codex——读任务书与原始会话，生成结构化回复，用沙箱 CLI 提交。"""
    session_files = list((sandbox / "session").iterdir())
    excerpt = ""
    if session_files:
        raw = session_files[0].read_text("utf-8", errors="ignore")
        excerpt = raw[:1500]
    s = help_obj.get("session") or {}
    reply = "\n".join([
        f"（mock 引擎自动回复）关于求助「{help_obj['question'][:80]}」：",
        "",
        f"- 目标会话：{help_obj['sessionId']}（{s.get('requirement', '?')} / {s.get('subtask', '?')}）",
        f"- 会话详细总结：{s.get('detailSummary', '（无）')}",
        f"- 本地原始会话共 {len(excerpt)}+ 字符，开头摘录：",
        "```",
        excerpt[:600] or "（空文件）",
        "```",
        "",
        "以上为本地会话的真实内容摘录，可作为云端继续工作的上下文。",
    ])
    out = sandbox / "output" / "reply.md"
    out.write_text(reply, "utf-8")
    node = shutil.which("node")
    if node:
        # 走沙箱 CLI 提交（顺带验证沙箱 CLI 通路）
        r1 = subprocess.run([node, "everyone.mjs", "help", "attach", "output/reply.md"],
                            cwd=sandbox, capture_output=True, text=True, timeout=60)
        r2 = subprocess.run([node, "everyone.mjs", "help", "reply", "--file", "output/reply.md",
                             "--note", "mock 引擎自动完成"],
                            cwd=sandbox, capture_output=True, text=True, timeout=60)
        return r2.returncode, (r1.stdout + r1.stderr + r2.stdout + r2.stderr).strip()[-2000:]
    # 没有 node：直接 REST 提交
    sandbox_conf = read_json(sandbox / "everyone-sandbox.json", {})
    api(cfg, "POST", f"/api/collab/help/{help_obj['id']}/attachments",
        {"filename": "reply.md", "contentBase64": base64.b64encode(reply.encode()).decode()},
        token=sandbox_conf["helpToken"])
    api(cfg, "POST", f"/api/collab/help/{help_obj['id']}/reply",
        {"text": reply, "note": "mock 引擎自动完成", "status": "succeeded"},
        token=sandbox_conf["helpToken"])
    return 0, "REST 直接提交完成"


# ===== 求助处理主流程（§十）=====

def submit_failure(cfg: dict, help_id: str, token: str, error: str) -> None:
    try:
        api(cfg, "POST", f"/api/collab/help/{help_id}/reply",
            {"status": "failed", "error": error[:800]}, token=token)
        log(f"✗ 已把失败原因回传云端：{error[:100]}")
    except ApiError as e:
        log(f"! 失败信息回传也失败了：{e}")


def process_help(cfg: dict, brief: dict) -> None:
    hid = brief["id"]
    log(f"收到远程求助 [{hid}]：{brief['question'][:60]}")

    # 领取（拿沙箱 token）
    try:
        claimed = api(cfg, "POST", f"/api/collab/help/{hid}/claim")
    except ApiError as e:
        log(f"! 领取失败（可能已被其他客户端领走）：{e}")
        return
    help_obj = claimed["help"]
    sandbox_token = help_obj["sandboxToken"]

    # §十一：按会话 ID 找本地原始会话；不存在/位置变化/无法读取 → 错误回传云端
    mapping = read_json(MAP_FILE, {})
    entry = mapping.get(help_obj["sessionId"]) or mapping.get(help_obj["sessionId"].upper())
    if not entry:
        submit_failure(cfg, hid, sandbox_token,
                       f"本地没有会话 {help_obj['sessionId']} 的映射记录（可能未用 --local-path 上传，或换了机器）")
        return
    src = Path(entry["path"])
    if not src.exists():
        submit_failure(cfg, hid, sandbox_token, f"会话原文已不存在或位置变化：{src}")
        return
    try:
        src.open("rb").close()
    except OSError as e:
        submit_failure(cfg, hid, sandbox_token, f"会话原文无法读取：{src}（{e}）")
        return

    # 建沙箱 → 标记执行中 → 启动引擎
    try:
        sandbox = build_sandbox(cfg, help_obj, entry, sandbox_token)
    except Exception as e:  # noqa: BLE001 —— 沙箱失败必须回传云端，不能让求助悬死
        submit_failure(cfg, hid, sandbox_token, f"沙箱创建失败：{e}")
        return
    log(f"沙箱就绪：{sandbox}")
    try:
        api(cfg, "POST", f"/api/collab/help/{hid}/status", {"status": "running"}, token=sandbox_token)
    except ApiError:
        pass

    if cfg["engine"] == "mock":
        code, tail = run_mock(cfg, sandbox, help_obj)
    else:
        code, tail = run_codex(cfg, sandbox)
    log(f"引擎退出（code={code}）")

    # 监听结果：Agent 应已通过沙箱 CLI 提交；没提交则兜底
    try:
        final = api(cfg, "GET", f"/api/collab/help/{hid}")["help"]
    except ApiError as e:
        log(f"! 查询求助状态失败：{e}")
        return
    if final["status"] in ("succeeded", "failed"):
        log(f"✓ 求助 [{hid}] 已完成（{final['status']}，由沙箱内 Agent 自行提交）")
        return
    if code == 0 and tail.strip():
        # 引擎正常结束但忘了调 CLI —— 把最终输出抢救回传
        try:
            api(cfg, "POST", f"/api/collab/help/{hid}/reply",
                {"text": f"（本地引擎输出，未经沙箱 CLI 提交，自动抢救回传）\n\n{tail[-3000:]}",
                 "note": "本地客户端兜底提交", "status": "succeeded"}, token=sandbox_token)
            log(f"✓ 求助 [{hid}] 兜底提交完成")
        except ApiError as e:
            log(f"! 兜底提交失败：{e}")
    else:
        submit_failure(cfg, hid, sandbox_token, f"本地引擎执行失败（code={code}）：{tail[-500:] or '无输出'}")


def cmd_run(args) -> None:
    cfg = load_config()
    if not cfg["base_url"] or not cfg["token"]:
        sys.exit("✗ 未配置，先运行 init")
    if not cfg.get("remote_help_enabled", True):
        sys.exit("✗ 用户未授权远程协作（client.json 里 remote_help_enabled=false）")
    interval = args.interval or cfg["poll_interval_sec"]
    who = api(cfg, "GET", "/api/collab/whoami")
    log(f"本地客户端启动：{who.get('name')} · 引擎 {cfg['engine']} · 每 {interval}s 轮询 {cfg['base_url']}")

    stop = {"flag": False}
    signal.signal(signal.SIGINT, lambda *_: stop.update(flag=True))
    signal.signal(signal.SIGTERM, lambda *_: stop.update(flag=True))

    while not stop["flag"]:
        try:
            pending = api(cfg, "GET", "/api/collab/help/pending")["helps"]
            for brief in pending:
                process_help(cfg, brief)
                if stop["flag"]:
                    break
        except ApiError as e:
            log(f"! 轮询失败：{e}")
        except Exception as e:  # noqa: BLE001 —— 常驻进程不能因单次异常退出
            log(f"! 未预期异常：{e}")
        if args.once:
            break
        for _ in range(int(interval * 2)):
            if stop["flag"]:
                break
            time.sleep(0.5)
    log("已退出")


def main() -> None:
    parser = argparse.ArgumentParser(description="Everyone 本地客户端（跨端协同）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init", help="初始化配置并验证连接")
    p.add_argument("--base-url")
    p.add_argument("--token")
    p.add_argument("--engine", choices=["codex", "mock"])
    p.set_defaults(fn=cmd_init)

    p = sub.add_parser("status", help="查看配置与连接状态")
    p.set_defaults(fn=cmd_status)

    p = sub.add_parser("scan", help="列出授权工具的候选会话文件")
    p.add_argument("--tool")
    p.set_defaults(fn=cmd_scan)

    p = sub.add_parser("map", help="会话 ID → 本地原始位置映射")
    msub = p.add_subparsers(dest="map_action", required=True)
    pa = msub.add_parser("add")
    pa.add_argument("session_id")
    pa.add_argument("--tool", required=True)
    pa.add_argument("--path", required=True)
    pa.add_argument("--workspace")
    pa.set_defaults(fn=cmd_map)
    pl = msub.add_parser("list")
    pl.set_defaults(fn=cmd_map)

    p = sub.add_parser("run", help="轮询处理远程求助（常驻）")
    p.add_argument("--once", action="store_true", help="处理一轮后退出")
    p.add_argument("--interval", type=int, help="轮询间隔秒数")
    p.set_defaults(fn=cmd_run)

    args = parser.parse_args()
    try:
        args.fn(args)
    except ApiError as e:
        sys.exit(f"✗ {e}")


if __name__ == "__main__":
    main()
