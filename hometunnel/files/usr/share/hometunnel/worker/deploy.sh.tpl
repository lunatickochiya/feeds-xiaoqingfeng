#!/bin/sh
# deploy.sh — hometunnel 控制面 Worker 一键部署（在你的电脑上运行，需要 Node.js）
# 由 HomeLede hometunnel LuCI 生成。做三件事:
#   1. 检查 wrangler（没有则 npx 自动拉取）
#   2. 写入 CTL_KEY secret
#   3. wrangler deploy（自动建 ctl.<domain> 自定义域 + DNS + 证书）
set -e

cd "$(dirname "$0")"

echo "== hometunnel control-plane worker deploy =="
echo "   target: @@CTL_HOSTNAME@@.@@DOMAIN@@"

if ! command -v npx >/dev/null 2>&1; then
	echo "ERROR: Node.js (npx) not found. Install Node.js 18+ first: https://nodejs.org" >&2
	exit 1
fi

echo "== step 1/3: wrangler login check =="
npx wrangler@latest whoami || {
	echo "Not logged in. Run: npx wrangler login"
	echo "then re-run ./deploy.sh"
	exit 1
}

echo "== step 2/3: set CTL_KEY secret =="
printf '%s' '@@CTL_KEY@@' | npx wrangler@latest secret put CTL_KEY

echo "== step 3/3: deploy =="
npx wrangler@latest deploy

echo ""
echo "Done. Verify in browser: https://@@CTL_HOSTNAME@@.@@DOMAIN@@/healthz"
echo "Then click 'Verify' in the LuCI wizard."
