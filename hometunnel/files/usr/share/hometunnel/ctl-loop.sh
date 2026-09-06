#!/bin/sh
# ctl-loop.sh — hometunnel-ctl 守护主循环（procd 实例体）
#
# 语义继承 AI-X-Space/llm-ondemand-tunnel v2（server/llm-tunnel-ctl.sh，commit 0fcbfe7）:
#   1. 每 poll_interval 秒拉 /cmd → want_on
#   2. fail-closed: 连续 fail_threshold 次失败 → 停隧道
#   3. hard_cap: 本地硬熔断；on_since 只在隧道真正启动时写，续期不穿透
#   4. auto_renew: metrics total_requests 增量 或 active_streams>0 → /cmd/beat?traffic=1
#      beat 成功不重置 FAILS（fail-closed 只跟 /cmd 挂钩）
#
# 移植要点（systemd → OpenWrt）:
#   - systemctl is-active → /etc/init.d/hometunnel running
#   - logger → syslog (logger -t hometunnel-ctl)
#   - date +%s、curl、awk 均为 busybox 可用

set -u

RUNDIR=/var/run/hometunnel
KEY_FILE=/etc/hometunnel/ctl.key
SVC=/etc/init.d/hometunnel

# ---- 从 UCI 读参数（非数字回退默认，防手工改坏）----
uci_get() { uci -q get "hometunnel.global.$1" || echo "$2"; }
num_or() { case "$1" in ''|*[!0-9]*) echo "$2" ;; *) echo "$1" ;; esac; }

CTL_HOST=$(uci_get ctl_hostname ctl)
DOMAIN=$(uci_get domain '')
POLL_SEC=$(num_or "$(uci_get poll_interval 10)" 10)
MAX_FAILS=$(num_or "$(uci_get fail_threshold 3)" 3)
HARD_CAP=$(num_or "$(uci_get hard_cap 14400)" 14400)
AUTO_RENEW=$(uci_get auto_renew 1)
METRICS_PORT=$(num_or "$(uci_get metrics_port 20241)" 20241)
METRICS_URL="http://127.0.0.1:${METRICS_PORT}/metrics"
CTL_URL="https://${CTL_HOST}.${DOMAIN}/cmd"

mkdir -p "$RUNDIR"
FAILS=0
LAST_TOTAL=""   # 空串 = 未采样（隧道刚启动，下一轮建立基线）

# 采 cloudflared Prometheus metrics: TOTAL(累计请求) ACTIVE(活跃流)
# 失败返回 1（两变量置空）。注: 部分 cloudflared 版本不导出 active_streams，仅增量信号可用。
sample_metrics() {
	local body
	body=$(curl -fsS --max-time 3 "$METRICS_URL" 2>/dev/null) || return 1
	TOTAL=$(echo "$body" | awk '$1 ~ /^cloudflared_tunnel_total_requests/ { print $NF; exit }' | tr -dc '0-9')
	ACTIVE=$(echo "$body" | awk '$1 ~ /^cloudflared_tunnel_active_streams/ { print $NF; exit }' | tr -dc '0-9')
}

tunnel_running() {
	"$SVC" running >/dev/null 2>&1
}

stop_tunnel() {
	"$SVC" stop >/dev/null 2>&1
	LAST_TOTAL=""
}

while true; do
	# ---- 1. 控制面拉取 ----
	body=$(curl -fsS --max-time 8 -H "x-ctl-key: $(cat "$KEY_FILE" 2>/dev/null)" "$CTL_URL" 2>/dev/null)
	if [ -n "$body" ]; then
		FAILS=0
		# shellcheck disable=SC2016
		want_on=$(echo "$body" | grep -q '"on": *true' && echo yes || echo no)
	else
		FAILS=$((FAILS + 1))
		want_on=unknown
		logger -t hometunnel-ctl "control fetch failed ($FAILS/$MAX_FAILS)"
	fi

	now=$(date +%s)
	on_since=$(cat "$RUNDIR/on_since" 2>/dev/null || echo 0)
	# on_since 缺失（tmpfs 清零/异常路径）时视为刚启动，避免误触硬熔断
	[ "$on_since" -gt 0 ] || on_since=$now

	if tunnel_running; then
		keep=yes
		[ "$want_on" = "no" ] && keep=no

		# ---- 2. 使用中自动续期 ----
		if [ "$AUTO_RENEW" = "1" ]; then
			traffic=0
			if sample_metrics; then
				if echo "$TOTAL" | grep -qE '^[0-9]+$'; then
					if echo "$LAST_TOTAL" | grep -qE '^[0-9]+$' && [ $((TOTAL - LAST_TOTAL)) -ge 1 ]; then
						traffic=1
					fi
					LAST_TOTAL=$TOTAL
				fi
				if echo "$ACTIVE" | grep -qE '^[0-9]+$' && [ "$ACTIVE" -ge 1 ] 2>/dev/null; then
					traffic=1
				fi
				if [ "$traffic" -eq 1 ]; then
					# beat 成功不重置 FAILS —— fail-closed 只跟 /cmd 拉取结果挂钩
					if curl -fsS --max-time 8 -H "x-ctl-key: $(cat "$KEY_FILE" 2>/dev/null)" \
						"${CTL_URL}/beat?traffic=1" >/dev/null 2>&1; then
						logger -t hometunnel-ctl "in use (total=${TOTAL:-?} active=${ACTIVE:-?}), ttl refreshed"
					else
						logger -t hometunnel-ctl "beat failed (ttl keeps draining)"
					fi
				fi
			else
				logger -t hometunnel-ctl "metrics sample failed (ttl keeps draining)"
			fi
		fi

		# ---- 3. hard_cap 本地硬熔断（可配，0=不限）----
		# 触发后同时熄灭 Worker 端开关（/off），否则下一轮 want_on 仍为 yes 会立即重启，
		# 熔断形同虚设。用户需要时重新 /on 即可（cap 限制的是单次会话时长）。
		if [ "$HARD_CAP" -gt 0 ] && [ $((now - on_since)) -ge "$HARD_CAP" ]; then
			keep=no
			logger -t hometunnel-ctl "local hard cap ${HARD_CAP}s reached, force stop"
			# 熄灭远程开关；失败也不回滚本地停止（本地安全优先）
			curl -fsS --max-time 8 -H "x-ctl-key: $(cat "$KEY_FILE" 2>/dev/null)" \
				"${CTL_URL%/cmd}/off" >/dev/null 2>&1 || \
				logger -t hometunnel-ctl "WARN: remote /off failed; user can turn off via web later"
		fi

		# ---- 4. fail-closed ----
		if [ "$FAILS" -ge "$MAX_FAILS" ]; then
			keep=no
			logger -t hometunnel-ctl "fail-closed, stop tunnel"
		fi

		if [ "$keep" = "no" ]; then
			stop_tunnel
			logger -t hometunnel-ctl "tunnel stopped"
		fi
	elif [ "$want_on" = "yes" ]; then
		echo "$now" > "$RUNDIR/on_since"
		LAST_TOTAL=""
		"$SVC" start >/dev/null 2>&1
		logger -t hometunnel-ctl "tunnel started"
	fi

	sleep "$POLL_SEC"
done
