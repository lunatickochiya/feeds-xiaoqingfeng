#!/usr/bin/env node
/* diagram.js 无 LuCI 环境冒烟测试：mock uci/fs/rpc/poll/view，
 * 断言各场景下 SVG 生成与分支逻辑。用法：node test/test-diagram.mjs */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'htdocs', 'luci-static',
	'resources', 'view', 'hometunnel', 'diagram.js'), 'utf8')
	.replace(/^'require [^']+';.*$/gm, '');

/* LuCI 的 String.prototype.format */
String.prototype.format = function (...args) {
	let i = 0;
	return this.replace(/%[sd]/g, (m) => (m === '%d' ? Math.round(args[i++]) : String(args[i++])));
};

/* 简化 DOM：E() 返回普通对象树 */
function E(tag, attrs, children) {
	const el = { tag, attrs: attrs || {}, children: [].concat(children ?? []).filter(Boolean) };
	el.appendChild = (c) => { el.children.push(c); };
	el.addEventListener = () => {};
	el.classList = { add() {}, remove() {} };
	if (attrs && typeof attrs.click === 'function') el.click = attrs.click;
	return el;
}

function makeEnv(uciState, statusText, ctlKey) {
	const uci = {
		get: (c, s, o) => uciState[c]?.[s]?.[o] ?? null,
		sections: (c, t) => Object.entries(uciState[c] || {})
			.filter(([, s]) => !t || s['.type'] === t)
			.map(([, s]) => s),
		load: () => Promise.resolve(['hometunnel'])
	};
	const fs = {
		read: (p) => (p === '/etc/hometunnel/ctl.key' && ctlKey != null)
			? Promise.resolve(ctlKey)
			: Promise.reject(new Error('enoent')),
		exec: (cmd, args) => (cmd.includes('hometunnel.sh') && args?.[0] === 'status')
			? Promise.resolve({ code: 0, stdout: statusText, stderr: '' })
			: Promise.reject(new Error('nope'))
	};
	const rpc = { declare: () => () => Promise.resolve({}) };
	const poll = { add: () => { } };
	const view = { extend: (o) => o };
	const L = {
		bind: (fn, ctx, ...a) => fn.bind(ctx, ...a),
		resolveDefault: (p, d) => p.catch(() => d),
		url: (...p) => '/' + p.join('/')
	};
	return { uci, fs, rpc, poll, view, L };
}

/* htui/ui.js 的 mock（apply 原样返回根节点） */
const htui = { apply: (root) => root };
const document = { getElementById: () => null, createElement: () => ({ style: {}, classList: { add() {} }, set textContent(v) {} }), head: { appendChild() {} } };

function runModule(env) {
	const fn = new Function('fs', 'poll', 'rpc', 'uci', 'view', 'L', 'E', '_', 'htui', 'document', src);
	return fn(env.fs, env.poll, env.rpc, env.uci, env.view, env.L, E, (s) => s, htui, document);
}

/* 深度遍历收集所有 innerHTML（SVG 字符串） */
function collectSvg(node, acc = []) {
	if (node.innerHTML) acc.push(node.innerHTML);
	for (const c of (node.children || []))
		if (typeof c === 'object' && c.tag) collectSvg(c, acc);
	return acc;
}

/* 深度序列化（找 URL 等文本） */
function serialize(node) {
	let out = '';
	if (node.children) for (const c of node.children)
		out += (typeof c === 'object' && c.tag) ? serialize(c) : String(c);
	return out;
}

const ing = (name, sub, svc, enabled = '1') =>
	({ '.type': 'ingress', '.name': 'c' + Math.random().toString(36).slice(2, 7), enabled, name, subdomain: sub, service: svc });

function baseUci(over = {}, ingresses = [ing('NAS', 'nas', 'http://192.168.1.10:5000'), ing('Git', 'git', 'ssh://192.168.1.20:22')]) {
	return { hometunnel: { global: { '.type': 'hometunnel', '.name': 'global',
		mode: 'ondemand', domain: 'example.com', ctl_hostname: 'ctl', tunnel_id: 'tid-1',
		default_ttl: '45', hard_cap: '14400', poll_interval: '10', ...over }, ...Object.fromEntries(ingresses.map(i => [i['.name'], i])) } };
}

const onText = `tunnel: stopped
control: {"on":true,"exp":${Date.now() + 44 * 60000 + 30000},"last_bump":false}`;
const offText = 'tunnel: stopped\ncontrol: {"on":false}';

let pass = 0, fail = 0;
function check(name, cond) {
	if (cond) { pass++; console.log(`  ok  ${name}`); }
	else { fail++; console.error(`FAIL  ${name}`); }
}

async function render(uci, status, key) {
	const env = makeEnv(uci, status, key);
	const mod = runModule(env);
	await mod.load();
	return await mod.render();
}

/* ---- 场景 1: ondemand + ON ---- */
{
	const c = await render(baseUci(), onText, 'testkey123');
	const svgs = collectSvg(c).join('\n');
	check('s1 svg generated', svgs.includes('<svg'));
	check('s1 ctl domain', svgs.includes('ctl.example.com'));
	check('s1 badge ON + min left', /ON · \d+ min left/.test(svgs));
	check('s1 data color green', svgs.includes('stroke="#059669" stroke-width="3"'));
	check('s1 flow animation', svgs.includes('class="dg-flow"'));
	check('s1 nas host', svgs.includes('nas.example.com'));
	check('s1 svc host strip scheme', svgs.includes('192.168.1.10:5000') && svgs.includes('192.168.1.20:22'));
	check('s1 renew note', svgs.includes('Auto-renew +45 min'));
	const flat = serialize(c);
	check('s1 url on with key', flat.includes('https://ctl.example.com/on?key=testkey123'));
	check('s1 url off with key', flat.includes('https://ctl.example.com/off?key=testkey123'));
}

/* ---- 场景 2: ondemand + OFF ---- */
{
	const c = await render(baseUci(), offText, 'testkey123');
	const svgs = collectSvg(c).join('\n');
	check('s2 badge OFF', />OFF</.test(svgs));
	check('s2 data color gray', svgs.includes('stroke="#94a3b8" stroke-width="3"'));
	check('s2 dashed segments', svgs.includes('stroke-dasharray="7 6"'));
	check('s2 off note', svgs.includes('Tunnel off · unreachable'));
	check('s2 no flow animation', !svgs.includes('class="dg-flow"'));
}

/* ---- 场景 3: alwayson ---- */
{
	const c = await render(baseUci({ mode: 'alwayson' }), '', null);
	const svgs = collectSvg(c).join('\n');
	check('s3 control band dimmed', svgs.includes('opacity="0.38"'));
	check('s3 always-on note', svgs.includes('Always-on mode · control plane not used'));
	check('s3 data color green', svgs.includes('stroke="#059669" stroke-width="3"'));
	check('s3 no badge', !/>OFF</.test(svgs) && !/ON ·/.test(svgs));
	check('s3 no url section', !serialize(c).includes('/on?key='));
}

/* ---- 场景 4: 向导未完成 ---- */
{
	const uci = baseUci({ tunnel_id: '' }, []);
	const c = await render(uci, '', null);
	const svgs = collectSvg(c).join('\n');
	check('s4 placeholder svg', svgs.includes('Wizard incomplete'));
	check('s4 wizard link', serialize(c).includes('Run the wizard first'));
	check('s4 no topology svg', !svgs.includes('ctl.example.com'));
}

/* ---- 场景 5: 5 条规则 → 3 + 溢出 ---- */
{
	const many = [ing('NAS', 'nas', 'http://192.168.1.10:5000'), ing('Git', 'git', 'http://192.168.1.20:80'),
		ing('Cam', 'cam', 'http://192.168.1.30:8080'), ing('Box', 'box', 'http://192.168.1.40:80'),
		ing('Pve', 'pve', 'https://192.168.1.50:8006')];
	const c = await render(baseUci({}, many), onText, 'k');
	const svgs = collectSvg(c).join('\n');
	check('s5 overflow count', /\+2 more/.test(svgs));
	check('s5 max 3 boxes', (svgs.match(/→ 192\.168\.1\./g) || []).length === 3);
	check('s5 domain count text', svgs.includes('5 domains'));
}

/* ---- 场景 6: 禁用规则不计入 + 无 key 无 URL 区 ---- */
{
	const c = await render(baseUci({}, [ing('NAS', 'nas', 'http://192.168.1.10:5000'), ing('Old', 'old', 'http://192.168.1.99:80', '0')]), offText, '');
	const svgs = collectSvg(c).join('\n');
	check('s6 disabled rule hidden', !svgs.includes('old.example.com'));
	check('s6 enabled rule shown', svgs.includes('nas.example.com'));
	check('s6 no key → no url section', !serialize(c).includes('/on?key='));
}

/* ---- 场景 7: hard_cap=0 → no hard cap ---- */
{
	const c = await render(baseUci({ hard_cap: '0' }), onText, 'k');
	const flat = serialize(c);
	check('s7 no hard cap legend', flat.includes('no hard cap'));
}

console.log(`\n===== diagram smoke: ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
