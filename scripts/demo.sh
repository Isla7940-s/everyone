#!/bin/bash
# Everyone · §10 demo 剧本串演（八幕，含代码任务）。
# 建议对干净的 mock 实例运行：
#   SERVER_PORT=8940 CHAT_ADAPTER=mock DATA_DIR=data-demo pnpm --filter @everyone/server start
#   DEMO_API=http://localhost:8940 ./scripts/demo.sh
set -e
API=${DEMO_API:-http://localhost:8902}

say() { # personId text [chatKind]
  curl -s -X POST $API/api/mock/message -H 'content-type: application/json' \
    -d "{\"personId\":\"$1\",\"text\":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$2"),\"chatKind\":\"${3:-group}\"}" > /dev/null
  echo "[$1] $2" | head -c 90; echo
}
click() { # msgId operatorId action extra_kv
  curl -s -X POST $API/api/mock/card-click -H 'content-type: application/json' \
    -d "{\"msgId\":\"$1\",\"operatorId\":\"$2\",\"value\":{\"action\":\"$3\",$4}}" > /dev/null
  echo "[click] $2 -> $3"
}
last_card() { # 最新一张卡的 msgId + 第一个按钮 task_id
  curl -s $API/api/mock/history | python3 -c "
import json,sys
msgs=json.load(sys.stdin)
cards=[m for m in msgs if m['kind']=='card']
c=cards[-1]
v={}
for el in (c.get('card') or {}).get('elements',[]):
    if el.get('tag')=='action':
        v=el['actions'][0].get('value',{})
print(c['msgId'], v.get('task_id',''))"
}
wait_status() { # task_id 目标状态 最大轮数(10s/轮)
  local ST=?
  for i in $(seq 1 ${3:-60}); do
    ST=$(curl -s $API/api/state | python3 -c "
import json,sys
ts=[t for t in json.load(sys.stdin)['tasks'] if t['id']=='$1']
print(ts[0]['status'] if ts else '?')")
    [ "$ST" = "$2" ] && break
    sleep 10
  done
  echo "任务 $1 状态: $ST"
}
dm_card_of() { # 某人私聊窗口里最新一张卡的 msgId
  curl -s $API/api/mock/history | python3 -c "
import json,sys
msgs=json.load(sys.stdin)
cards=[m for m in msgs if m['kind']=='card' and m['chatId']=='mock-p2p-$1']
print(cards[-1]['msgId'] if cards else '')"
}

echo '=== 幕 1：群聊快闪（承诺会蒸发）==='
say laowang "小明，上次说的竞品数据你看了吗？"
sleep 3
say xiaohong "我明天发你，最近有点忙"
sleep 12

echo '=== 幕 2：承诺被记住 ==='
say xiaoming "这周五前我把星航App竞品分析报告发到群里"
echo "等待意图识别与确认卡…"
sleep 15
read CARD TASK <<< "$(last_card)"
echo "确认卡: $CARD 任务: $TASK"
click "$CARD" xiaoming task_confirm "\"task_id\":\"$TASK\""
echo "等待四象限图 + 能力自评 + 分身开工…"
sleep 12

echo '=== 幕 3：分身写稿（OpenCode 真跑）==='
wait_status "$TASK" reviewing 60

echo '=== 幕 4：私信迭代 ==='
say xiaoming "开头的 TL;DR 再压缩一点，威胁等级要写判断依据" p2p
echo "等第 2 稿…"
sleep 8
wait_status "$TASK" reviewing 60

echo '=== 幕 5：发布 + 评审团 ==='
PUBCARD=$(dm_card_of xiaoming)
click "$PUBCARD" xiaoming draft_publish "\"task_id\":\"$TASK\""
echo "等评审团（分析 + 3 人设）…"
sleep 100

echo '=== 幕 6：代码任务（非报告类：接 → 沙箱改代码 → 变更报告）==='
say xiaoming "今天下班前我把 star-utils 里日期显示提前一个月的 bug 修掉，把测试跑绿"
sleep 15
read CARD2 TASK2 <<< "$(last_card)"
echo "确认卡: $CARD2 任务: $TASK2"
click "$CARD2" xiaoming task_confirm "\"task_id\":\"$TASK2\""
wait_status "$TASK2" reviewing 60
PUBCARD2=$(dm_card_of xiaoming)
click "$PUBCARD2" xiaoming draft_publish "\"task_id\":\"$TASK2\""
echo "代码变更报告已发布"
sleep 20

echo '=== 幕 7：帮你答 ==='
say xiaohong "问一下，上次定的活动预算口径是多少？超了怎么办？"
sleep 30

echo '=== 幕 8：日报（含分身今日完成段）==='
curl -s -X POST $API/api/digest/run > /dev/null
sleep 40

echo '=== 剧本完成，导出关键指标 ==='
curl -s $API/api/state | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('tasks:', [(t['title'][:18], t.get('taskKind'), t['status']) for t in d['tasks']])
print('completionRate:', d['completionRate'])
print('reviews:', len(d['reviews']))
print('assists:', [(a['type'], a['status']) for a in d['assists']])"
