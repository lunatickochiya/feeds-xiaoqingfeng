#!/bin/sh
# e2e-test.sh — hometunnel 回环 e2e（复刻灵感项目 server/e2e-test.sh 4 阶段法）
#
# 在普通 Linux/git-bash 上模拟 OpenWrt 环境，验证 ctl-loop.sh 状态机全链路:
#   阶段1: 控制面 on → 隧道启动（假 init）
#   阶段2: 有流量（假 metrics 计数增长）→ beat 续期（假 Worker exp 增加）
#   阶段3: 控制面 off → 隧道停止
#   阶段4: 控制面连续失败 → fail-closed 停止
#   附加:  hard_cap 熔断（缩短到 6s 验证）
#
# 布景:
#   FAKE_ROOT/  — 假文件系统: etc/init.d/hometunnel(假), etc/hometunnel/ctl.key, var/run/hometunnel/
#   假 Worker   — node 起的本地 HTTP 服务（渲染 worker.js.tpl 的真代码，强一致状态在内存）
#   假 metrics — node 起的本地 HTTP 服务，/metrics 可通过打点文件控制计数
#   ctl-loop.sh 经 sed 改写路径后运行（UCI 用假 shim 替代）

set -u
cd "$(dirname "$0")/.."

# 临时目录: git-bash 下用 Windows 混合路径（C:/...），node 原生程序也能读；Linux 用 /tmp
if command -v cygpath >/dev/null 2>&1; then
	TMPBASE=$(cygpath -m "$LOCALAPPDATA")/Temp
	SRCM=$(cygpath -m "$(pwd)")
else
	TMPBASE=${TMPDIR:-/tmp}
	SRCM=$(pwd)
fi
WORK=$(mktemp -d "$TMPBASE/ht-e2e.XXXXXX") || exit 1
FAKE_ROOT="$WORK/root"

# 端口残留检查（上次异常退出会留下孤儿 node，导致 EADDRINUSE 假失败）
for p in 18081 18082; do
	if curl -fsS --max-time 1 "http://127.0.0.1:$p/healthz" >/dev/null 2>&1; then
		echo "FATAL: port $p already in use (leftover process?) — free it and retry" >&2
		exit 2
	fi
done

mkdir -p "$FAKE_ROOT/etc/init.d" "$FAKE_ROOT/etc/hometunnel" "$FAKE_ROOT/var/run/hometunnel" "$FAKE_ROOT/usr/bin" "$FAKE_ROOT/usr/share/hometunnel"

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok  $1"; }
bad() { fail=$((fail+1)); echo "  FAIL $1"; }
section() { echo; echo "== $1 =="; }

# 后台子进程输出重定向到文件（不继承终端管道，防止挂起调用方）
run_worker() { E2E_KEY="$CTL_KEY" node "$WORK/worker-server.mjs" >"$WORK/worker.log" 2>&1 & WORKER_PID=$!; }
run_loop()   { sh "$WORK/ctl-loop-test.sh" >"$WORK/loop.log" 2>&1 & LOOP_PID=$!; }

cleanup() {
	[ -n "${LOOP_PID:-}" ] && kill "$LOOP_PID" 2>/dev/null
	curl -fsS --max-time 2 "http://127.0.0.1:$PORT_WORKER/shutdown" >/dev/null 2>&1
	[ -n "${METRICS_PID:-}" ] && kill "$METRICS_PID" 2>/dev/null
	# HT_E2E_KEEP=1 时保留现场（调试用）
	if [ "${HT_E2E_KEEP:-0}" = "1" ]; then
		echo "(WORK kept at $WORK)"
	else
		rm -rf "$WORK"
	fi
}
trap cleanup EXIT INT TERM

# ---------- 布景 1: 假 UCI shim ----------
cat > "$FAKE_ROOT/usr/bin/uci" <<'EOF'
#!/bin/sh
# 假 uci: 只支持 hometunnel.global.<opt> get，值来自 env 前缀 HTTEST_（兼容 -q 等前缀）
args=""
for a in "$@"; do
	case "$a" in
		-*) ;;          # 忽略 flag
		*) args="$args $a" ;;
	esac
done
set -- $args
case "$1" in
	get)
		key=$(echo "$2" | sed 's/^hometunnel\.global\.//')
		eval "val=\${HTTEST_${key}:-}"
		[ -n "$val" ] && echo "$val"
		exit 0
		;;
	*) exit 0 ;;
esac
EOF
chmod +x "$FAKE_ROOT/usr/bin/uci"

# ---------- 布景 2: 假 init（记录 start/stop 到日志，状态在文件）----------
# 假 init 状态/日志也放 $WORK（Windows 混合路径 sh 可读写）
# 注意: running 的判定结果就是退出码（case 内最后命令），不能 exit 0 兜底
TSTATE="$WORK/tunnel-state"
TLOG="$WORK/tunnel.log"
cat > "$FAKE_ROOT/etc/init.d/hometunnel" <<EOF
#!/bin/sh
STATE=$TSTATE
LOG=$TLOG
case "\${1:-}" in
	start) echo running > "\$STATE"; echo "\$(date +%s) start" >> "\$LOG"; exit 0 ;;
	stop)  echo stopped > "\$STATE"; echo "\$(date +%s) stop" >> "\$LOG"; exit 0 ;;
	running) [ "\$(cat \$STATE 2>/dev/null)" = running ]; exit \$? ;;
	*) exit 0 ;;
esac
EOF
chmod +x "$FAKE_ROOT/etc/init.d/hometunnel"

# ---------- 布景 3: 真 Worker（node 本地起）----------
CTL_KEY="e2e-test-key-123"
printf '%s' "$CTL_KEY" > "$FAKE_ROOT/etc/hometunnel/ctl.key"
PORT_WORKER=18081
PORT_METRICS=18082
cat > "$WORK/worker-server.mjs" <<EOF
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const tpl = readFileSync('$SRCM/files/usr/share/hometunnel/worker/worker.js.tpl', 'utf8');
const rendered = tpl.replace(/@@DEFAULT_TTL@@/g, '1').replace(/@@MAX_TTL@@/g, '240').replace(/@@RENEW_TTL@@/g, '1');
const tmp = mkdtempSync(join(tmpdir(), 'e2e-w-'));
const p = join(tmp, 'w.mjs');
writeFileSync(p, rendered);
const worker = await import('file:///' + p.split('\\\\').join('/'));
const state = { storage: { map: new Map(), async get(k) { return this.map.get(k); }, async put(k, v) { this.map.set(k, structuredClone(v)); } } };
const doObj = new worker.CtlState(state, { CTL_KEY: process.env.E2E_KEY });
const srv = (await import('node:http')).createServer(async (req, res) => {
	/* 模拟 default export: /healthz 无鉴权直接返回，其余转 DO */
	if (req.url.replace(/\/+$/, '') === '/healthz') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ ok: true }));
		return;
	}
	/* 测试专用: 干净退出（绕开 MSYS/Windows pid 空间不一致） */
	if (req.url.replace(/\/+$/, '') === '/shutdown') {
		res.writeHead(200);
		res.end('bye');
		setTimeout(() => process.exit(0), 50);
		return;
	}
	const r = await doObj.fetch(new Request('http://ctl' + req.url, { headers: { 'x-ctl-key': req.headers['x-ctl-key'] || '' } }));
	const body = await r.text();
	res.writeHead(r.status, { 'content-type': 'application/json' });
	res.end(body);
});
srv.listen(${PORT_WORKER}, '127.0.0.1');
EOF
run_worker

# ---------- 布景 4: 假 metrics ----------
cat > "$WORK/metrics-server.mjs" <<EOF
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const CTR = '${WORK}/metrics-counter';
const srv = createServer((req, res) => {
	const total = readFileSync(CTR, 'utf8').trim() || '0';
	res.writeHead(200, { 'content-type': 'text/plain' });
	res.end(
		'# HELP cloudflared_tunnel_total_requests total\n' +
		'cloudflared_tunnel_total_requests{} ' + total + '\n' +
		'# HELP cloudflared_tunnel_active_streams active\n' +
		'cloudflared_tunnel_active_streams 0\n'
	);
});
srv.listen(${PORT_METRICS}, '127.0.0.1');
EOF
echo 0 > "$WORK/metrics-counter"
node "$WORK/metrics-server.mjs" &
METRICS_PID=$!

# 等两个服务就绪
sleep 1
curl -fsS "http://127.0.0.1:$PORT_WORKER/healthz" >/dev/null || { echo "worker boot failed"; exit 1; }
curl -fsS "http://127.0.0.1:$PORT_METRICS/metrics" >/dev/null || { echo "metrics boot failed"; exit 1; }

# ---------- 布景 5: 改写 ctl-loop.sh 路径并运行 ----------
sed -e "s|^RUNDIR=.*|RUNDIR=$FAKE_ROOT/var/run/hometunnel|" \
    -e "s|^KEY_FILE=.*|KEY_FILE=$FAKE_ROOT/etc/hometunnel/ctl.key|" \
    -e "s|^SVC=.*|SVC=$FAKE_ROOT/etc/init.d/hometunnel|" \
    -e "s|^CTL_URL=.*|CTL_URL=http://127.0.0.1:$PORT_WORKER/cmd|" \
    -e "s|/sbin/logger|logger|" \
    files/usr/share/hometunnel/ctl-loop.sh > "$WORK/ctl-loop-test.sh"
chmod +x "$WORK/ctl-loop-test.sh"

# 假 uci 在 PATH 最前（MSYS 需 /c/ 风格路径才能 exec；混合路径仅用于文件读写）
if command -v cygpath >/dev/null 2>&1; then
	export PATH="$(cygpath -u "$FAKE_ROOT")/usr/bin:$PATH"
else
	export PATH="$FAKE_ROOT/usr/bin:$PATH"
fi
export HTTEST_ctl_hostname=127.0.0.1:$PORT_WORKER
export HTTEST_domain=''
export HTTEST_poll_interval=1
export HTTEST_fail_threshold=3
export HTTEST_hard_cap=14400
export HTTEST_auto_renew=1
export HTTEST_metrics_port=$PORT_METRICS

# 假 logger（busybox logger 在 git-bash 没有）——路径生成时展开
if ! command -v logger >/dev/null 2>&1; then
	printf '#!/bin/sh\necho "[logger] $*" >> %s\n' "$TLOG" > "$FAKE_ROOT/usr/bin/logger"
	chmod +x "$FAKE_ROOT/usr/bin/logger"
fi

section "阶段1: /on → 隧道启动"
curl -fsS -H "x-ctl-key: $CTL_KEY" "http://127.0.0.1:$PORT_WORKER/on?min=2" >/dev/null
run_loop
sleep 3
if [ "$(cat $TSTATE 2>/dev/null)" = running ]; then ok "tunnel started"; else bad "tunnel NOT started"; fi

section "阶段2: 有流量 → beat 续期"
echo 5 > "$WORK/metrics-counter"   # 制造增量
sleep 2
echo 8 > "$WORK/metrics-counter"
sleep 3
if grep -q "ttl refreshed" $TLOG; then ok "beat sent (ttl refreshed)"; else bad "no beat logged"; fi

section "阶段3: /off → 隧道停止"
curl -fsS -H "x-ctl-key: $CTL_KEY" "http://127.0.0.1:$PORT_WORKER/off" >/dev/null
sleep 3
if [ "$(cat $TSTATE 2>/dev/null)" = stopped ]; then ok "tunnel stopped"; else bad "tunnel NOT stopped"; fi

# stop_worker — 通过 /shutdown 端点干净停掉假 worker（MSYS kill 对原生 node 无效且 pid 空间不一致）
stop_worker() {
	curl -fsS --max-time 3 "http://127.0.0.1:$PORT_WORKER/shutdown" >/dev/null 2>&1
	for i in 1 2 3 4 5; do
		curl -fsS --max-time 2 "http://127.0.0.1:$PORT_WORKER/healthz" >/dev/null 2>&1 || return 0
		sleep 1
	done
}

# wait_state <want> <timeout_sec> — 限期轮询假隧道状态（每轮守护迭代可达数秒，固定 sleep 不可靠）
wait_state() {
	local want="$1"
	local tmo="$2"
	local deadline=$(( $(date +%s) + tmo ))
	while [ "$(cat "$TSTATE" 2>/dev/null)" != "$want" ] && [ "$(date +%s)" -lt "$deadline" ]; do
		sleep 1
	done
	[ "$(cat "$TSTATE" 2>/dev/null)" = "$want" ]
}

section "阶段4: fail-closed（控制面失联×3）"
stop_worker
# 重启 worker 让 on=true，随后杀掉模拟控制面失联
run_worker
for i in 1 2 3 4 5 6 7 8 9 10; do
	curl -fsS "http://127.0.0.1:$PORT_WORKER/healthz" >/dev/null 2>&1 && break
	sleep 1
done
curl -fsS -H "x-ctl-key: $CTL_KEY" "http://127.0.0.1:$PORT_WORKER/on?min=30" >/dev/null
sleep 2   # 守护拉起隧道
[ "$(cat "$TSTATE" 2>/dev/null)" = running ] && ok "tunnel re-started" || bad "tunnel not re-started"
stop_worker
if wait_state stopped 25; then ok "fail-closed stopped tunnel"; else bad "fail-closed did NOT stop"; fi

section "阶段5: hard_cap 熔断（6s 上限）"
kill "$LOOP_PID" 2>/dev/null; wait "$LOOP_PID" 2>/dev/null
export HTTEST_hard_cap=6
run_worker
for i in 1 2 3 4 5 6 7 8 9 10; do
	curl -fsS "http://127.0.0.1:$PORT_WORKER/healthz" >/dev/null 2>&1 && break
	sleep 1
done
curl -fsS -H "x-ctl-key: $CTL_KEY" "http://127.0.0.1:$PORT_WORKER/on?min=30" >/dev/null
run_loop
if wait_state running 20; then ok "tunnel running (before cap)"; else bad "tunnel not running before cap"; fi
if wait_state stopped 20; then ok "hard cap force-stopped"; else bad "hard cap did NOT stop"; fi
# cap 联动 /off 后 Worker 端开关应已熄灭（不再重启 = 振荡修复）
WON=$(curl -fsS -H "x-ctl-key: $CTL_KEY" "http://127.0.0.1:$PORT_WORKER/cmd" 2>/dev/null | grep -q '"on": *false' && echo yes || echo no)
[ "$WON" = "yes" ] && ok "worker /off synced (no flapping restart)" || bad "worker still on (flapping)"
grep -q "hard cap" $TLOG && ok "cap logged" || bad "cap not logged"

echo
echo "===== e2e result: $pass passed, $fail failed ====="
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
