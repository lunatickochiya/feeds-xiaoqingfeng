hometunnel 外网开关部署包（Cloudflare Worker）
================================

由 HomeLede 路由器上的 hometunnel 应用生成（/tmp/hometunnel-worker-@@DOMAIN@@.tar.gz）。

这是「手动部署」备用包: 当路由器已完成 OAuth 授权（向导第④步）时, 无需此包 ——
路由器会自动上传并部署 Worker, 并自动挂载自定义域。

包含:
  src/worker.js     Worker 代码（继承 AI-X-Space/llm-ondemand-tunnel，Apache-2.0）
  wrangler.toml     部署配置（自定义域 @@CTL_HOSTNAME@@.@@DOMAIN@@）
  deploy.sh         一键部署脚本
  ctl.key.txt       开关密钥（也是路由器 /etc/hometunnel/ctl.key 的值）

在你有 Node.js 的电脑上:

  tar xzf hometunnel-worker-*.tar.gz
  cd hometunnel-worker
  ./deploy.sh

deploy.sh 会:
  1. 引导 wrangler login（浏览器 OAuth 授权 Cloudflare 账号）
  2. 写入 CTL_KEY secret
  3. 部署 Worker 并挂载自定义域 @@CTL_HOSTNAME@@.@@DOMAIN@@（证书自动签发）
