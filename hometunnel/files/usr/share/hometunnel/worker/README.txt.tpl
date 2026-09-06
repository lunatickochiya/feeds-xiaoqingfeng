hometunnel 控制面 Worker 部署包
================================

由 HomeLede 路由器上的 hometunnel 应用生成（/tmp/hometunnel-worker-@@DOMAIN@@.tar.gz）。

包含:
  src/worker.js     Worker 代码（继承 AI-X-Space/llm-ondemand-tunnel，Apache-2.0）
  wrangler.toml     部署配置（自定义域 @@CTL_HOSTNAME@@.@@DOMAIN@@）
  deploy.sh         一键部署脚本
  ctl.key.txt       控制密钥（也是路由器 /etc/hometunnel/ctl.key 的值）

在你有 Node.js 的电脑上:

  tar xzf hometunnel-worker-*.tar.gz
  cd hometunnel-worker
  ./deploy.sh

deploy.sh 会:
  1. 引导 wrangler login（浏览器 OAuth 授权 Cloudflare 账号）
  2. 写入 CTL_KEY secret
  3. 部署 Worker 并自动创建 @@CTL_HOSTNAME@@.@@DOMAIN@@ 自定义域（含 DNS + 证书）

部署完成后回到路由器 LuCI 向导点"验证"。

费用: Cloudflare Workers 免费额度（10 万请求/天）。路由器 10s 轮询约 8600 请求/天，
远低于上限。Tunnel 本身免费不限量。

安全提示: ctl.key 只能开关隧道，无法访问你的内网服务；删除本目录前先确认路由器
/etc/hometunnel/ctl.key 已保存（重新 bundle 可再生成同 key 的部署包）。
