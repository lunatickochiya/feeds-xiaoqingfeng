#!/usr/bin/env node
/**
 * test-worker.mjs — hometunnel Worker DO 状态机单测（本地，无 wrangler）
 * 复刻灵感项目 AI-X-Space/llm-ondemand-tunnel worker/test-beat.mjs 的 7 场景 + bump 边界
 *
 * 运行: node test-worker.mjs  （先渲染 worker.js.tpl 占位符）
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ---- 1. 渲染模板 ---- */
const tpl = readFileSync(new URL('../files/usr/share/hometunnel/worker/worker.js.tpl', import.meta.url), 'utf8');
const rendered = tpl
	.replace(/@@DEFAULT_TTL@@/g, '45')
	.replace(/@@MAX_TTL@@/g, '240')
	.replace(/@@RENEW_TTL@@/g, '45');
const tmp = mkdtempSync(join(tmpdir(), 'ht-worker-'));
const modPath = join(tmp, 'worker.mjs');
writeFileSync(modPath, rendered);
const worker = await import('file://' + modPath.replace(/\\/g, '/'));

/* ---- 2. 假 DO 运行时 ---- */
class FakeStorage {
	constructor() { this.map = new Map(); }
	async get(k) { return this.map.get(k); }
	async put(k, v) { this.map.set(k, structuredClone(v)); }
	async delete(k) { this.map.delete(k); }
}

function makeDO() {
	const state = { storage: new FakeStorage() };
	const doObj = new worker.CtlState(state, { CTL_KEY: 'testkey' });
	/* Worker fetch 不经过 default export 的路由（healthz 等），直接打 DO */
	const doFetch = (path, key) => doObj.fetch(new Request(
		'https://ctl.example.com' + path,
		key ? { headers: { 'x-ctl-key': key } } : {}));
	return { doFetch, storage: state.storage };
}

let passed = 0, failed = 0;
function check(name, cond, extra) {
	if (cond) { passed++; console.log(`  ok  ${name}`); }
	else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
}
const j = async (r) => await r.json();

/* ---- 3. 场景 ---- */
console.log('scenario 1: unauthorized key rejected');
{
	const { doFetch } = makeDO();
	const r = await doFetch('/cmd', 'wrongkey');
	check('401 on wrong key', r.status === 401);
}

console.log('scenario 2: /on then /cmd shows on=true with exp');
{
	const { doFetch } = makeDO();
	const r = await j(await doFetch('/on?min=10', 'testkey'));
	check('state=on', r.state === 'on');
	check('valid_minutes=10', r.valid_minutes === 10);
	const c = await j(await doFetch('/cmd', 'testkey'));
	check('cmd on=true', c.on === true);
	check('exp > now', c.exp > Date.now());
}

console.log('scenario 3: /off clears state');
{
	const { doFetch } = makeDO();
	await doFetch('/on?min=10', 'testkey');
	const r = await j(await doFetch('/off', 'testkey'));
	check('state=off', r.state === 'off');
	const c = await j(await doFetch('/cmd', 'testkey'));
	check('cmd on=false', c.on === false);
}

console.log('scenario 4: TTL expiry lazy-settled on /cmd');
{
	const { doFetch, storage } = makeDO();
	await doFetch('/on?min=1', 'testkey');
	/* 手动把 exp 拨到过去 */
	const st = await storage.get('state');
	st.exp = Date.now() - 1000;
	await storage.put('state', st);
	const c = await j(await doFetch('/cmd', 'testkey'));
	check('expired → on=false', c.on === false);
	check('reason=ttl-expired', c.reason === 'ttl-expired');
}

console.log('scenario 5: beat traffic=1 near expiry bumps TTL');
{
	const { doFetch, storage } = makeDO();
	await doFetch('/on?min=45', 'testkey');
	let st = await storage.get('state');
	const nearExpiry = Date.now() + 3 * 60_000; /* < 5min threshold */
	st.exp = nearExpiry;
	await storage.put('state', st);
	const r = await j(await doFetch('/cmd/beat?traffic=1', 'testkey'));
	check('beat=bump', r.beat === 'bump', r);
	check('state stays on', r.state === 'on');
	st = await storage.get('state');
	check('exp pushed ~+45min', st.exp > Date.now() + 40 * 60_000, st.exp - Date.now());
}

console.log('scenario 6: beat without traffic does NOT bump');
{
	const { doFetch, storage } = makeDO();
	await doFetch('/on?min=45', 'testkey');
	let st = await storage.get('state');
	const nearExpiry = Date.now() + 3 * 60_000;
	st.exp = nearExpiry;
	await storage.put('state', st);
	const r = await j(await doFetch('/cmd/beat', 'testkey')); /* 无 traffic=1 */
	check('beat=keepalive', r.beat === 'keepalive', r);
	st = await storage.get('state');
	check('exp unchanged', Math.abs(st.exp - nearExpiry) < 2000);
}

console.log('scenario 7: beat with traffic but far from expiry does NOT bump (anti-inflate)');
{
	const { doFetch, storage } = makeDO();
	await doFetch('/on?min=45', 'testkey');
	const farFromExpiry = Date.now() + 40 * 60_000; /* > 5min remaining */
	let st = await storage.get('state');
	st.exp = farFromExpiry;
	await storage.put('state', st);
	const r = await j(await doFetch('/cmd/beat?traffic=1', 'testkey'));
	check('beat label=bump (request classification)', r.beat === 'bump', r);
	st = await storage.get('state');
	check('exp unchanged (no actual renewal far from expiry)', Math.abs(st.exp - farFromExpiry) < 2000);
}

console.log('scenario 8: beat on off-state ignored');
{
	const { doFetch } = makeDO();
	const r = await j(await doFetch('/cmd/beat?traffic=1', 'testkey'));
	check('beat ignored when off', r.state === 'off' && r.beat === 'ignored');
}

console.log('scenario 9: /on min clamping (default/max)');
{
	const { doFetch } = makeDO();
	let r = await j(await doFetch('/on?min=abc', 'testkey'));
	check('invalid min → default 45', r.valid_minutes === 45);
	r = await j(await doFetch('/on?min=99999', 'testkey'));
	check('oversize min → clamp 240', r.valid_minutes === 240);
	r = await j(await doFetch('/on', 'testkey'));
	check('missing min → default 45', r.valid_minutes === 45);
}

console.log('scenario 10: timing-safe key compare (digest path works)');
{
	const { doFetch } = makeDO();
	/* 正确 key 走 header 与 query 均可 */
	let r = await j(await doFetch('/cmd', 'testkey'));
	check('header key ok', r.on !== undefined);
	/* 空 key 拒绝 */
	r = await doFetch('/cmd', '');
	check('empty key rejected', r.status === 401);
}

/* ---- 4. default export 路由（healthz 无鉴权） ---- */
console.log('scenario 11: default export healthz (no auth)');
{
	/* 简化: 直接调用 default.fetch，DO 绑定用假 stub */
	const handler = worker.default;
	const r = await handler.fetch(new Request('https://ctl.example.com/healthz'), {});
	check('healthz ok', (await j(r)).ok === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
