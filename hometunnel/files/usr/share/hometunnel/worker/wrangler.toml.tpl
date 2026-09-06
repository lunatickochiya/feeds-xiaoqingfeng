# hometunnel 控制面 Worker — 由 HomeLede hometunnel LuCI 生成（请勿手改占位符产物）
name = "hometunnel-ctl"
main = "src/worker.js"
compatibility_date = "2026-08-01"

# 自定义域（@@DOMAIN@@ zone 需在本 CF 账号；deploy 自动建 DNS + 证书）
# 必须自定义域: workers.dev 在大陆被 SNI 阻断
routes = [
	{ pattern = "@@CTL_HOSTNAME@@.@@DOMAIN@@", custom_domain = true }
]

# Durable Object（SQLite 存储，免费额度；开关状态强一致、无传播延迟）
[[durable_objects.bindings]]
name = "CTL_STATE"
class_name = "CtlState"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["CtlState"]

# CTL_KEY 走 secret，不进本文件（deploy.sh 会写入）
