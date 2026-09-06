#!/usr/bin/env node
/* 把 wizard.js 的 msgid 追加进 pot + zh_Hans po（已存在的跳过） */
const fs = require('fs');
const base = process.argv[2];
const ids = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

const zh = {
	"Fetch Domains": "获取域名列表",
	"Fix the issue (e.g. router DNS), reload this page and try again.": "修复问题（如路由器 DNS）后刷新本页重试。",
	"Pick the domain for your tunnel hostnames (fetched automatically from your Cloudflare account).": "选择隧道主机名所用的域名（自动从你的 Cloudflare 账户获取）。",
	"Refetch": "重新获取",
	"Save Domain": "保存域名",
	"Saved! Loading next step…": "已保存！正在进入下一步…",
	"cloudflared exited before the certificate was fetched:": "证书尚未拉取，cloudflared 已退出：",
	"③ Choose Domain": "③ 选择域名",
	"④ Ingress Rules": "④ 接入规则",
	"⑤ Publish DNS": "⑤ 发布 DNS",
	"⑥ Control-plane Worker": "⑥ 控制面 Worker",
	"⑦ Verify & Finish": "⑦ 验证并完成"
};

const esc = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
let pot = fs.readFileSync(base + '/templates/hometunnel.pot', 'utf8');
let po = fs.readFileSync(base + '/zh_Hans/hometunnel.po', 'utf8');
let added = 0;
for (const id of ids) {
	if (pot.includes(`msgid "${esc(id)}"`)) continue;
	const block = `\nmsgid "${esc(id)}"\nmsgstr ""\n`;
	pot += block;
	const trans = zh[id];
	po += trans != null ? `\nmsgid "${esc(id)}"\nmsgstr "${esc(trans)}"\n` : block;
	added++;
}
fs.writeFileSync(base + '/templates/hometunnel.pot', pot);
fs.writeFileSync(base + '/zh_Hans/hometunnel.po', po);
console.log('added', added, 'entries each');
