# hometunnel — HomeLede 全免费 Cloudflare Tunnel 内网穿透

灵感与控制面协议来源: [AI-X-Space/llm-ondemand-tunnel](https://github.com/AI-X-Space/llm-ondemand-tunnel)（Apache-2.0）

## 是什么

在 OpenWrt/HomeLede 路由器上，把内网服务通过 Cloudflare Tunnel（免费、无需公网 IP、无需端口转发）发布到你的自有域名，并带**外网一键启停**：

- **全免费**：Cloudflare Tunnel 不限流量 + Workers 免费额度（DO 10s 轮询 ≈ 8.6k req/天，远低于 10 万/天上限）
- **零 API Token**：路由器上只需要 `cloudflared tunnel login` 的 cert.pem 和一个自生成的 CTL_KEY；Worker 部署用 wrangler OAuth（在你自己的电脑上跑两条命令）
- **按需启停**（ondemand 模式，默认）：隧道平时不运行，从外网点书签 `https://ctl.<domain>/on` 即开，TTL 到期自动关；使用中有流量自动续期；4 小时（可配）本地硬熔断
- **常驻模式**（alwayson）：开机即连，不做按需管理

## 前置要求

1. 一个 Cloudflare 账号（免费版即可）
2. 一个域名，DNS 托管在 Cloudflare
3. 你的电脑上有 Node.js（部署控制面 Worker 用，一次性）

## 快速开始

LuCI → 服务 → HomeTunnel → 向导，六步走完：

1. **授权** — 路由器上运行 `tunnel login`，浏览器粘贴授权 URL
2. **创建** — `tunnel create hometunnel`（隧道名默认 hometunnel）
3. **DNS** — 为每条 ingress 规则发布 `xxx.<domain>` CNAME 到 `<tunnel-id>.cfargotunnel.com`
4. **部署控制面** — 下载 wrangler 部署包（内含 Worker 代码 + 随机 CTL_KEY），电脑上跑 `npx wrangler login` + `npx wrangler deploy`
5. **校验** — 路由器自动验证控制面连通（healthz + /cmd）
6. **启用** — 按配置生成 config.yml，启动守护

之后状态页有开/关书签按钮（带二维码），手机一扫即开。

## 架构

```
外网浏览器 ──HTTPS──> Cloudflare 边缘
  ├─ ctl.<domain>  → Worker (DO 单例, 状态机: on/off/TTL/beat 续期)
  │                    ▲ 10s 轮询 /cmd + 有流量时 /cmd/beat?traffic=1
  └─ app.<domain>   → cloudflared tunnel ──> 内网服务 (192.168.x.x:port)
                         ▲ procd 拉起/停止
                     hometunnel-ctl 守护
```

三层关停：手动 `/off` → Worker TTL（+使用中续期）→ 本地 hard_cap 熔断（默认 14400s，可配 0=不限）。

## 文件布局

| 路径 | 用途 | 权限 |
|---|---|---|
| `/etc/hometunnel/cert.pem` | cloudflared 账号证书（login 产物） | 600 |
| `/etc/hometunnel/<tunnel-id>.json` | 隧道凭据 | 600 |
| `/etc/hometunnel/ctl.key` | 控制面密钥（自生成） | 600 |
| `/etc/hometunnel/config.yml` | ingress 配置（UCI 生成） | 600 |
| `/var/run/hometunnel/` | 守护状态（on_since 等，tmpfs） | 700 |

## UCI 配置（`/etc/config/hometunnel`）

```sh
config hometunnel 'global'
	option enabled '1'
	option mode 'ondemand'      # ondemand | alwayson
	option tunnel_name 'hometunnel'
	option domain 'example.com'
	option ctl_hostname 'ctl'
	option poll_interval '10'   # 秒
	option fail_threshold '3'
	option default_ttl '45'     # 分钟
	option auto_renew '1'       # 使用中自动续期
	option renew_ttl '45'       # 续期时长（分钟）
	option max_ttl '240'        # Worker 端 TTL 上限（分钟）
	option hard_cap '14400'     # 本地硬熔断（秒，0=不限）
	option metrics_port '20241' # cloudflared --metrics
	option protocol 'auto'      # quic | http2 | auto

config ingress
	option name 'nas'
	option subdomain 'nas'
	option service 'http://192.168.1.10:5000'
	option enabled '1'
```

## 测试

```sh
# Worker DO 状态机单测（本地 Node ≥18，无需 wrangler）
node test/test-worker.mjs

# 守护状态机回环 e2e（假 Worker + 假 metrics + 假 init）
sh test/e2e-test.sh
```

## 与 passwall2 等代理共存

cloudflared 与 CF 边缘的 QUIC/443 若被路由器自身 ACL 劫持，`protocol` 切 `http2`。控制面必须用自定义域（workers.dev 在大陆被 SNI 阻断）。

## 许可

Apache-2.0。控制面 Worker 继承自 AI-X-Space/llm-ondemand-tunnel（Apache-2.0）。
