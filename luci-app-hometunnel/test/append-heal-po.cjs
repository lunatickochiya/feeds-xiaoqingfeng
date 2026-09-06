#!/usr/bin/env node
/* 追加自愈相关 msgid 到 pot + zh_Hans po */
const fs = require('fs');
const base = process.argv[2];
const ids = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

const zh = {
	"Cloudflare rejected the saved certificate. Re-run wizard step ① to re-authorize.": "Cloudflare 拒绝了已保存的证书。请重新执行向导第 ① 步重新授权。",
	"The tunnel was deleted on Cloudflare. Re-run the wizard (it will recreate it automatically).": "隧道已在 Cloudflare 侧被删除。重新运行向导（将自动重建）。",
	"Tunnel on Cloudflare": "Cloudflare 侧隧道",
	"certificate rejected": "证书被拒",
	"deleted on Cloudflare": "已在 Cloudflare 删除",
	"ok": "正常",
	"unknown": "未知",
	"Cloudflare rejected the saved certificate. Re-run step ① first.": "Cloudflare 拒绝了已保存的证书。请先重新执行第 ① 步。",
	"The tunnel was deleted on Cloudflare. Clicking Create below will recreate it automatically (new tunnel id, DNS routes re-published in step ⑤).": "隧道已在 Cloudflare 侧被删除。点击下方“创建”将自动重建（新隧道 ID，第 ⑤ 步会重新发布 DNS 路由）。"
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
