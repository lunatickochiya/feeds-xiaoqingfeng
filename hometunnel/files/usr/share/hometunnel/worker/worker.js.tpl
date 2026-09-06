/**
 * hometunnel-ctl — HomeLede Cloudflare Tunnel 控制面 Worker
 *
 * 继承自 AI-X-Space/llm-ondemand-tunnel（Apache-2.0）并改造:
 *   - CTL_KEY timing-safe 比较（摘要后 timingSafeEqual）
 *   - TTL 参数模板化（DEFAULT/MAX/RENEW 由部署包注入）
 *   - /cmd 响应带 version 字段（协议协商余地）
 *
 * 路由:
 *   GET /healthz                无鉴权存活探测
 *   GET /on?key=K[&min=N]       开隧道（默认 @@DEFAULT_TTL@@ 分钟，上限 @@MAX_TTL@@）
 *   GET /off?key=K              关隧道
 *   GET /cmd                    路由器轮询（header x-ctl-key；TTL 惰性结算）
 *   GET /cmd/beat?traffic=1     路由器上报"使用中"；剩余<5min 且有流量才续 @@RENEW_TTL@@ 分钟
 *   GET /status                 人读状态
 *
 * 存储: Durable Object（SQLite 后端，单例强一致，无 KV 传播延迟）
 * Secret: CTL_KEY（wrangler secret put CTL_KEY）
 */
const VERSION = 1;
const DEFAULT_MIN = @@DEFAULT_TTL@@;
const MAX_MIN = @@MAX_TTL@@;
const REFRESH_MIN = @@RENEW_TTL@@;
const BUMP_THRESHOLD_MS = 5 * 60_000;  // 剩余 < 5 分钟且有流量才续，避免 TTL 无谓膨胀

const encoder = new TextEncoder();

function json(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

/** constant-time key 比较: 双方 SHA-256 摘要后逐字节比较（Workers 原生 timingSafeEqual，其余运行时手写等价） */
async function keyOk(provided, expected) {
	if (!expected || !provided) return false;
	const a = await crypto.subtle.digest('SHA-256', encoder.encode(provided));
	const b = await crypto.subtle.digest('SHA-256', encoder.encode(expected));
	if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
	if (a.byteLength !== b.byteLength) return false;
	const va = new Uint8Array(a), vb = new Uint8Array(b);
	let diff = 0;
	for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
	return diff === 0;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const path = url.pathname.replace(/\/+$/, '') || '/';
		if (path === '/healthz') return json({ ok: true, version: VERSION });
		const id = env.CTL_STATE.idFromName('singleton');
		const stub = env.CTL_STATE.get(id);
		return stub.fetch(request);
	},
};

export class CtlState {
	constructor(state, env) {
		this.storage = state.storage;
		this.env = env;
	}

	async fetch(request) {
		const url = new URL(request.url);
		const path = url.pathname.replace(/\/+$/, '') || '/';
		const key = request.headers.get('x-ctl-key') || url.searchParams.get('key');
		if (!(await keyOk(key, this.env.CTL_KEY))) return json({ error: 'unauthorized' }, 401);

		const now = Date.now();

		if (path === '/on') {
			let min = parseInt(url.searchParams.get('min') || '', 10);
			if (!Number.isFinite(min) || min < 1) min = DEFAULT_MIN;
			if (min > MAX_MIN) min = MAX_MIN;
			const tag = url.searchParams.get('tag') || '';
			const state = { on: true, exp: now + min * 60_000, opened_at: now, tag,
				ip: request.headers.get('cf-connecting-ip') || '' };
			await this.storage.put('state', state);
			return json({ state: 'on', valid_minutes: min, expires_at: new Date(state.exp).toISOString() });
		}

		if (path === '/off') {
			const state = { on: false, exp: 0, closed_at: now };
			await this.storage.put('state', state);
			return json({ state: 'off' });
		}

		// 路由器"使用中"上报。traffic=1（真实新请求/活跃流）且 TTL 快耗尽才续；
		// 无流量 keepalive 不延长——人走了 TTL 自然耗尽自动关。
		if (path === '/cmd/beat') {
			let st = (await this.storage.get('state')) || { on: false, exp: 0 };
			if (!st.on) return json({ state: 'off', beat: 'ignored' });
			if (st.exp && st.exp <= now) {
				st = { on: false, exp: 0, closed_at: now, reason: 'ttl-expired' };
				await this.storage.put('state', st);
				return json({ ...st, state: 'off' });
			}
			const traffic = url.searchParams.get('traffic') === '1';
			if (traffic && st.exp - now < BUMP_THRESHOLD_MS) {
				st.exp = now + REFRESH_MIN * 60_000;
				st.last_bump = now;
			}
			st.last_beat = now;
			await this.storage.put('state', st);
			return json({ state: 'on', beat: traffic ? 'bump' : 'keepalive', version: VERSION,
				expires_at: new Date(st.exp).toISOString() });
		}

		if (path === '/cmd' || path === '/status') {
			let st = (await this.storage.get('state')) || { on: false, exp: 0 };
			if (st.on && st.exp && st.exp <= now) {
				st = { on: false, exp: 0, closed_at: now, reason: 'ttl-expired' };
				await this.storage.put('state', st);
			}
			return json({ ...st, version: VERSION });
		}

		return json({ ok: true, version: VERSION,
			usage: 'GET /on /off /cmd /cmd/beat /status  (?key= or header x-ctl-key)' });
	}
}
