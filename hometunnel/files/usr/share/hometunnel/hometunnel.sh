#!/bin/sh
# hometunnel.sh — 核心子命令 CLI（向导后端/运维入口）
#
# 子命令:
#   job <name> <cmd...>     后台 job: setsid+nohup 执行，输出→/var/run/hometunnel/<name>.out，结束写 .rc
#   jobstatus <name>        查询 job: running|done:<rc>|missing
#   login                   cloudflared tunnel login（HOME=/etc/hometunnel），由向导以 job 形式调用
#   create                  tunnel create <name>（幂等: 已存在则复用），提取 UUID 写 UCI
#   route                   对每条 enabled ingress 执行 tunnel route dns
#   regen                   gen-yml.sh + 平滑重启数据面（若在运行）
#   bundle                  生成 Worker 部署包 /tmp/hometunnel-worker-<domain>.tar.gz
#   verify                  控制面连通性验证: /healthz + /cmd（带 key）
#   status                  人读状态汇总
#   cleanup                 tunnel delete + 清理指引
#   zones                   用 cert.pem 内的 apiToken 列出账户全部 Cloudflare zone（域名）
#   apply-mode              按 UCI mode 联动两个 init 的 enable 状态并 start/stop
#   genkey                  生成/重建 /etc/hometunnel/ctl.key
#
# 灵感与协议来源: AI-X-Space/llm-ondemand-tunnel (Apache-2.0)

set -u

SHARE=/usr/share/hometunnel
RUNDIR=/var/run/hometunnel
ETC=/etc/hometunnel
UCI_CONF=hometunnel
CF=/usr/bin/cloudflared
KEY_FILE=$ETC/ctl.key

log() { logger -t hometunnel "$*"; }
msg() { echo "$*"; }

die() { echo "ERROR: $*" >&2; exit 1; }

# 读取 UCI（带默认值）
get_() { uci -q get "hometunnel.global.$1" || echo "$2"; }

ctl_base_url() {
	echo "https://$(get_ ctl_hostname ctl).$(get_ domain '')"
}

genkey() {
	mkdir -p "$ETC"
	chmod 700 "$ETC"
	head -c 24 /dev/urandom | base64 | tr -d '\n' > "$KEY_FILE"
	chmod 600 "$KEY_FILE"
	msg "ctl.key generated"
}

# mark <flag> — 向导断点标记（/var/run/hometunnel/<flag>，tmpfs 重启清零=重做向导尾部）
cmd_mark() {
	mkdir -p "$RUNDIR"
	: > "$RUNDIR/$1"
	msg "marked: $1"
}

# set <key> <value> — 向导轻量写 UCI（仅限 global 段已知键）
cmd_set() {
	local key val
	key="${1:-}"
	val="${2:-}"
	case "$key" in
		domain|ctl_hostname|tunnel_name|default_ttl|hard_cap)
			;;
		*)
			die "refusing to set unknown key: $key"
			;;
	esac
	case "$val" in
		*[!a-zA-Z0-9._-]*)
			die "invalid characters in value"
			;;
	esac
	uci set "$UCI_CONF.global.$key=$val"
	uci commit "$UCI_CONF"
	msg "OK: $key saved"
}

# ---- 后台 job 机制（向导异步长任务）----
# job <name> <cmd...>: setsid+nohup 运行, stdout+stderr 实时追加到 /var/run/hometunnel/<name>.out
#   （login 等长任务需要边跑边读输出，故不用 .part 原子改名）
#   命令结束后写 <name>.rc（退出码）；<name>.pid 存在且进程活着 = running
job_start() {
	local name="$1"; shift
	[ -n "$name" ] || die "job: missing name"
	mkdir -p "$RUNDIR"
	# 同名 job 在跑则拒绝
	if [ -f "$RUNDIR/$name.pid" ] && kill -0 "$(cat "$RUNDIR/$name.pid" 2>/dev/null)" 2>/dev/null; then
		die "job '$name' already running"
	fi
	rm -f "$RUNDIR/$name.rc" "$RUNDIR/$name.out"
	: > "$RUNDIR/$name.out"
	chmod 600 "$RUNDIR/$name.out"
	# setsid 脱离 rpcd 会话进程组（登录会话结束 job 不被杀）；无 setsid（busybox 未编）降级 nohup
	# 两分支统一参数序: _ <name> <rundir> <cmd...>；内部先取 name/rundir 再 shift 2 还原 "$@"
	if command -v setsid >/dev/null 2>&1; then
		setsid nohup sh -c '
			name=$1; rundir=$2; shift 2
			"$@" > "$rundir/$name.out" 2>&1
			echo $? > "$rundir/$name.rc"
		' _ "$name" "$RUNDIR" "$@" >/dev/null 2>&1 &
	else
		nohup sh -c '
			name=$1; rundir=$2; shift 2
			"$@" > "$rundir/$name.out" 2>&1
			echo $? > "$rundir/$name.rc"
		' _ "$name" "$RUNDIR" "$@" >/dev/null 2>&1 &
	fi
	echo $! > "$RUNDIR/$name.pid"
	msg "job '$name' started (pid $(cat "$RUNDIR/$name.pid"))"
}

job_status() {
	local name="$1" pid
	if [ -f "$RUNDIR/$name.rc" ]; then
		rm -f "$RUNDIR/$name.pid"
		msg "done:$(cat "$RUNDIR/$name.rc")"
		return 0
	fi
	pid=$(cat "$RUNDIR/$name.pid" 2>/dev/null) || { msg "missing"; return 0; }
	if kill -0 "$pid" 2>/dev/null; then
		msg "running"
	else
		# 进程消失但无 .rc（异常退出/被 kill -9）——写 rc=999 避免向导死等
		echo 999 > "$RUNDIR/$name.rc"
		msg "done:999"
	fi
}

# ---- cloudflared 操作（全部 HOME=/etc/hometunnel，凭据收敛）----
cf_run() {
	HOME=$ETC "$CF" --no-autoupdate "$@"
}

cmd_login() {
	# 由向导以 job 形式调用；stdout 会打印 auth URL 供用户点击
	log "tunnel login starting"
	cf_run tunnel login
}

cmd_create() {
	local name id creds out
	name=$(get_ tunnel_name hometunnel)
	mkdir -p "$ETC/.cloudflared"
	chmod 700 "$ETC/.cloudflared"

	# 幂等: 已有 tunnel_id 则校验凭据存在
	id=$(get_ tunnel_id '')
	if [ -n "$id" ] && [ -f "$ETC/.cloudflared/$id.json" ]; then
		msg "OK: tunnel already exists (id=$id)"
		return 0
	fi

	out=$(cf_run tunnel create "$name" 2>&1) || die "tunnel create failed: $out"
	# Created tunnel <name> with id <uuid>
	id=$(echo "$out" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -n1)
	[ -n "$id" ] || die "cannot parse tunnel id from: $out"
	creds="$ETC/.cloudflared/$id.json"
	[ -f "$creds" ] || die "credentials file not found: $creds"
	chmod 600 "$creds" 2>/dev/null
	chmod 600 "$ETC/.cloudflared/cert.pem" 2>/dev/null
	uci set "$UCI_CONF.global.tunnel_id=$id"
	uci commit "$UCI_CONF"
	msg "OK: tunnel '$name' created (id=$id)"
}

cmd_route() {
	local name id domain i=0 subdomain hostname out rc=0 cmd_rc
	name=$(get_ tunnel_name hometunnel)
	id=$(get_ tunnel_id '')
	domain=$(get_ domain '')
	[ -n "$id" ] || die "tunnel_id empty (run create first)"
	[ -n "$domain" ] || die "domain empty"

	while uci -q show hometunnel | grep -q "^hometunnel.@ingress\[$i\]="; do
		enabled=$(uci -q get "hometunnel.@ingress[$i].enabled" || echo 1)
		if [ "$enabled" = "1" ] || [ "$enabled" = "true" ]; then
			subdomain=$(uci -q get "hometunnel.@ingress[$i].subdomain" || echo '')
			if [ -n "$subdomain" ]; then
				hostname="$subdomain.$domain"
				out=$(cf_run tunnel route dns "$name" "$hostname" 2>&1)
				cmd_rc=$?
				case "$out" in
					*"Already routed"*|*"already exists"*)
						msg "OK: $hostname (already routed)"
						;;
					*)
						if [ "$cmd_rc" -eq 0 ]; then
							msg "OK: $hostname routed"
						else
							msg "FAIL: $hostname: $out"
							rc=1
						fi
						;;
				esac
			fi
		fi
		i=$((i + 1))
	done
	return "$rc"
}

cmd_regen() {
	"$SHARE/gen-yml.sh" || die "gen-yml failed"
	# 数据面在运行则平滑重启
	if /etc/init.d/hometunnel running 2>/dev/null; then
		/etc/init.d/hometunnel restart
		msg "OK: config regenerated, tunnel service restarted"
	else
		msg "OK: config regenerated (tunnel service not running)"
	fi
}

cmd_bundle() {
	local domain ctl_host key out tmp f
	domain=$(get_ domain '')
	ctl_host=$(get_ ctl_hostname ctl)
	key=$(cat "$KEY_FILE" 2>/dev/null)
	[ -n "$domain" ] || die "domain empty"
	[ -n "$key" ] || die "ctl.key missing (run genkey)"

	out="/tmp/hometunnel-worker-$domain.tar.gz"
	tmp=$(mktemp -d /tmp/hometunnel-bundle.XXXXXX) || die "mktemp failed"
	mkdir -p "$tmp/hometunnel-worker/src"

	for f in worker.js wrangler.toml deploy.sh README.txt; do
		sed -e "s|@@DOMAIN@@|$domain|g" \
		    -e "s|@@CTL_HOSTNAME@@|$ctl_host|g" \
		    -e "s|@@CTL_KEY@@|$key|g" \
		    -e "s|@@DEFAULT_TTL@@|$(get_ default_ttl 45)|g" \
		    -e "s|@@MAX_TTL@@|$(get_ max_ttl 240)|g" \
		    -e "s|@@RENEW_TTL@@|$(get_ renew_ttl 45)|g" \
		    "$SHARE/worker/$f.tpl" > "$tmp/hometunnel-worker/$f"
	done
	# worker.js 放 src/（wrangler.toml main = src/worker.js）
	mv "$tmp/hometunnel-worker/worker.js" "$tmp/hometunnel-worker/src/worker.js"
	chmod +x "$tmp/hometunnel-worker/deploy.sh"
	# 控制密钥副本（与路由器 /etc/hometunnel/ctl.key 同值）
	printf '%s\n' "$key" > "$tmp/hometunnel-worker/ctl.key.txt"
	chmod 600 "$tmp/hometunnel-worker/ctl.key.txt"

	tar -C "$tmp" -czf "$out" hometunnel-worker
	rm -rf "$tmp"
	chmod 600 "$out"
	msg "$out"
}

cmd_verify() {
	local base key resp
	base=$(ctl_base_url)
	key=$(cat "$KEY_FILE" 2>/dev/null)
	[ -n "$key" ] || die "ctl.key missing"

	resp=$(curl -fsS --max-time 10 "$base/healthz" 2>&1) || die "healthz failed: $resp"
	echo "$resp" | grep -q '"ok": *true' || die "healthz unexpected: $resp"
	msg "healthz: OK"

	resp=$(curl -fsS --max-time 10 -H "x-ctl-key: $key" "$base/cmd" 2>&1) || die "/cmd failed: $resp"
	echo "$resp" | grep -q '"on"' || die "/cmd unexpected: $resp"
	msg "/cmd: OK ($resp)"
}

# ctl on|off — 路由器侧直接开关（LuCI 按钮用；key 走 header 不落 URL/进程参数）
cmd_ctl() {
	local action="${1:-}" base key min resp
	base=$(ctl_base_url)
	key=$(cat "$KEY_FILE" 2>/dev/null)
	[ -n "$key" ] || die "ctl.key missing"
	case "$action" in
		on)
			min=$(get_ default_ttl 45)
			resp=$(curl -fsS --max-time 10 -H "x-ctl-key: $key" "${base}/on?min=${min}" 2>&1) \
				|| die "/on failed: $resp"
			msg "$resp"
			;;
		off)
			resp=$(curl -fsS --max-time 10 -H "x-ctl-key: $key" "${base}/off" 2>&1) \
				|| die "/off failed: $resp"
			msg "$resp"
			;;
		*)
			die "usage: hometunnel.sh ctl on|off"
			;;
	esac
}

cmd_status() {
	local mode tunnel_id domain base
	mode=$(get_ mode ondemand)
	tunnel_id=$(get_ tunnel_id '')
	domain=$(get_ domain '')
	base=$(ctl_base_url)
	echo "--- hometunnel status ---"
	echo "mode:        $mode"
	echo "tunnel_id:   ${tunnel_id:-<empty>}"
	echo "domain:      ${domain:-<empty>}"
	echo "ctl url:     $base"
	if /etc/init.d/hometunnel running >/dev/null 2>&1; then echo "tunnel svc:  running"; else echo "tunnel svc:  stopped"; fi
	if /etc/init.d/hometunnel-ctl running >/dev/null 2>&1; then echo "ctl svc:     running"; else echo "ctl svc:     stopped"; fi
	if [ -f "$KEY_FILE" ]; then echo "ctl key:     present"; else echo "ctl key:     MISSING"; fi
	if [ -n "$tunnel_id" ] && [ -n "$domain" ] && [ -f "$KEY_FILE" ]; then
		resp=$(curl -fsS --max-time 8 -H "x-ctl-key: $(cat "$KEY_FILE")" "$base/cmd" 2>/dev/null) \
			&& echo "control:     $resp" || echo "control:     unreachable"
	fi
}

# 从 cert.pem 的 ARGO TUNNEL TOKEN 解出 apiToken（cfut_…，可调 CF API v4）
cert_api_token() {
	awk '/BEGIN ARGO TUNNEL TOKEN/{f=1;next} /END ARGO TUNNEL TOKEN/{f=0} f' \
		"$ETC/.cloudflared/cert.pem" 2>/dev/null | tr -d '\n' | base64 -d 2>/dev/null \
		| grep -oE '"apiToken":"[^"]+"' | cut -d'"' -f4
}

# 列出账户全部 zone（域名）。输出: <name> <status> 每行一个；失败 die。
cmd_zones() {
	local token resp
	[ -f "$ETC/.cloudflared/cert.pem" ] || die "cert.pem not found (run login first)"
	token=$(cert_api_token)
	[ -n "$token" ] || die "cannot parse apiToken from cert.pem"
	resp=$(curl -fsS --max-time 15 -H "Authorization: Bearer $token" \
		"https://api.cloudflare.com/client/v4/zones?per_page=50" 2>&1) \
		|| die "cloudflare api unreachable: $resp"
	# jsonfilter 为 OpenWrt 原生 JSON 工具；-e 提取数组元素
	names=$(jsonfilter -s "$resp" -e '@.result[*].name' 2>/dev/null)
	stats=$(jsonfilter -s "$resp" -e '@.result[*].status' 2>/dev/null)
	[ -n "$names" ] || die "no zones in account (or parse error)"
	# BusyBox 无 paste；awk 双文件按行号配对 name/status
	tmp=$(mktemp /tmp/ht-zones.XXXXXX)
	printf '%s\n' "$names" > "$tmp.n"
	printf '%s\n' "$stats" > "$tmp.s"
	awk 'NR==FNR { n[NR]=$0; next } { print n[FNR], $0 }' "$tmp.n" "$tmp.s" 2>/dev/null \
		|| printf '%s\n' "$names"
	rm -f "$tmp.n" "$tmp.s"
}

cmd_cleanup() {
	local name id ans
	name=$(get_ tunnel_name hometunnel)
	id=$(get_ tunnel_id '')
	/etc/init.d/hometunnel stop 2>/dev/null
	/etc/init.d/hometunnel-ctl stop 2>/dev/null
	if [ -n "$id" ]; then
		echo "About to delete tunnel '$name' ($id) from Cloudflare."
		echo "DNS CNAME records and the Worker (ctl.$(get_ domain '')) must be removed manually."
		printf 'Type DELETE to confirm: '
		read -r ans
		[ "$ans" = "DELETE" ] || { msg "aborted"; exit 1; }
		cf_run tunnel delete "$id" 2>&1 || msg "WARN: tunnel delete failed (delete in CF dashboard)"
	fi
	rm -f "$ETC/config.yml" "$KEY_FILE"
	msg "local config cleaned. UCI values kept (uci revert hometunnel to restore defaults)"
}

cmd_apply_mode() {
	local mode
	mode=$(get_ mode ondemand)
	case "$mode" in
		ondemand)
			# 数据面不 enable（只被守护拉起），控制面守护启用
			/etc/init.d/hometunnel-ctl enable
			/etc/init.d/hometunnel-ctl restart 2>/dev/null || true
			# 刻意不 stop 数据面——由守护按控制面状态决定（避免误杀使用中会话）
			msg "OK: ondemand mode applied (ctl daemon enabled)"
			;;
		alwayson)
			/etc/init.d/hometunnel-ctl stop 2>/dev/null || true
			/etc/init.d/hometunnel-ctl disable
			/etc/init.d/hometunnel enable
			/etc/init.d/hometunnel restart
			msg "OK: alwayson mode applied"
			;;
		*) die "unknown mode: $mode" ;;
	esac
}

case "${1:-}" in
	job)
		shift
		job_start "$@"
		;;
	jobstatus)
		shift
		job_status "$@"
		;;
	login)      cmd_login ;;
	create)     cmd_create ;;
	route)      cmd_route ;;
	regen)      cmd_regen ;;
	bundle)     cmd_bundle ;;
	verify)     cmd_verify ;;
	ctl)        shift; cmd_ctl "$@" ;;
	status)     cmd_status ;;
	zones)      cmd_zones ;;
	cleanup)    cmd_cleanup ;;
	apply-mode) cmd_apply_mode ;;
	mark)       shift; cmd_mark "$@" ;;
	set)        shift; cmd_set "$@" ;;
	genkey)     genkey ;;
	*)
		cat <<'EOF'
usage: hometunnel.sh <command>
  job <name> <cmd...>   run command as background job (wizard backend)
  jobstatus <name>      running | done:<rc> | missing
  login                 cloudflared tunnel login (HOME=/etc/hometunnel)
  create                create tunnel (idempotent), write tunnel_id to UCI
  route                 route dns for all enabled ingress rules
  regen                 regenerate config.yml + smooth restart
  bundle                build worker deployment tarball to /tmp
  verify                verify control plane (healthz + /cmd)
  ctl on|off            turn tunnel on/off from the router side (LuCI buttons)
  status                human-readable status
  zones                 list all Cloudflare zones (domains) via cert.pem token
  cleanup               delete tunnel + local cleanup
  apply-mode            apply UCI mode to init enable states
  set <key> <value>     set a global UCI option (wizard backend)
  genkey                (re)generate ctl.key
EOF
		exit 1
		;;
esac
