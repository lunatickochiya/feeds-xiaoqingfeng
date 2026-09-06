#!/usr/bin/env node
/* 把 diagram.js 的 msgid 追加进 pot + zh_Hans po（已存在的跳过） */
const fs = require('fs');
const base = process.argv[2];
const ids = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

const zh = {
	"%d domains": "%d 个域名",
	"+%d more": "还有 %d 条",
	"Always-on mode · control plane not used": "常开模式 · 控制面未启用",
	"Any device · no app needed": "任意设备 · 无需 App",
	"Any external device": "外网任意设备",
	"Auto-renew +%d min on traffic": "有流量自动续期 +%d 分钟",
	"Bookmark": "书签",
	"Browser": "浏览器",
	"Cloudflare Worker (free)": "Cloudflare Worker（免费）",
	"Cloudflare edge network": "Cloudflare 边缘网络",
	"Control plane · switch tunnel": "控制面 · 开关隧道",
	"Control signaling (tunnel on/off)": "控制信令（开/关隧道）",
	"Copied ✓": "已复制 ✓",
	"Copy OFF url": "复制 OFF 链接",
	"Copy ON url": "复制 ON 链接",
	"Data plane · external access": "数据面 · 外网访问",
	"Finish the 6-step wizard to see your live topology here.": "完成 6 步向导后，这里将展示你的实时隧道拓扑。",
	"LAN": "内网 LAN",
	"Live topology generated from your configuration.": "由你的配置实时生成的拓扑图。",
	"No ingress rules yet": "还没有接入规则",
	"ON · %d min left": "ON · 剩余 %d 分钟",
	"OpenWrt router": "OpenWrt 路由器",
	"Polls /cmd every %ds": "每 %ds 轮询 /cmd",
	"Save these as bookmarks on any device to open/close the tunnel from anywhere:": "保存为任意设备的浏览器书签，即可随时随地打开/关闭隧道：",
	"Traffic (HTTPS)": "访问流量（HTTPS）",
	"Tunnel Topology": "隧道拓扑",
	"Tunnel off · unreachable": "隧道未开启 · 不可达",
	"Wizard incomplete - topology pending": "向导未完成 · 拓扑待生成",
	"auto-off after %dh hard cap": "%d 小时硬上限自动熄灭",
	"ctl-loop daemon": "ctl-loop 守护进程",
	"no hard cap": "无硬上限",
	"start / stop": "拉起 / 熄灭",
	"tunnel data engine": "隧道数据引擎",
	"① Bookmark ON / OFF": "① 书签开 / 关",
	"② Poll commands": "② 轮询指令",
	"③ HTTPS": "③ HTTPS"
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
