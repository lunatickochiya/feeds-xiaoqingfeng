/* SPDX-License-Identifier: Apache-2.0 */
/* Copyright (C) 2026 xiaoqingfeng <xiaoqingfeng@yeah.net> */
/* hometunnel wizard — 8 步断点向导（job 异步轮询） */

'use strict';
'require fs';
'require poll';
'require rpc';
'require uci';
'require view';
'require view.hometunnel.ui as htui';

var HT = '/usr/share/hometunnel/hometunnel.sh';
var RUNDIR = '/var/run/hometunnel';
var OAUTH_JSON = '/etc/hometunnel/oauth.json';

/* job 轮询: { state: 'running'|'done', rc } */
function jobPoll(name) {
	return fs.exec(HT, ['jobstatus', name]).then(function (res) {
		var s = (res.stdout || '').trim();
		if (s.indexOf('done:') === 0)
			return { state: 'done', rc: parseInt(s.slice(5), 10) };
		if (s === 'running')
			return { state: 'running' };
		return { state: 'missing' };
	}).catch(function () { return { state: 'missing' }; });
}

function jobOut(name) {
	return fs.read_direct(RUNDIR + '/' + name + '.out').catch(function () { return ''; });
}

/* 从 login 输出提取 cloudflared 授权 URL */
function extractAuthUrl(text) {
	var m = (text || '').match(/https:\/\/dash\.cloudflare\.com\/argotunnel\?[^\s"']+/);
	return m ? m[0] : null;
}

return view.extend({
	load: function () {
		return uci.load('hometunnel');
	},

	render: function () {
		var self = this;

		return this.probeState().then(function () {
			return self.renderInner();
		});
	},

	probeState: function () {
		var self = this;
		return fs.stat('/etc/hometunnel/.cloudflared/cert.pem').then(function (st) {
			self.certOk = !!(st && st.size > 0);
		}).catch(function () { self.certOk = false; }).then(function () {
			self.ingressCount = uci.sections('hometunnel', 'ingress').filter(function (s) {
				return s.enabled !== '0';
			}).length;
			return fs.stat(RUNDIR + '/dns-routed');
		}).then(function (st) {
			self.dnsOk = !!(st && st.size > 0);
		}).catch(function () { self.dnsOk = false; }).then(function () {
			return fs.stat(OAUTH_JSON);
		}).then(function (st) {
			self.oauthOk = !!(st && st.size > 0);
		}).catch(function () { self.oauthOk = false; }).then(function () {
			return fs.stat(RUNDIR + '/worker-verified');
		}).then(function (st) {
			self.workerOk = !!(st && st.size > 0);
		}).catch(function () { self.workerOk = false; });
	},

	getStep: function () {
		if (!this.certOk) return 1;
		if (!uci.get('hometunnel', 'global', 'tunnel_id')) return 2;
		if (!uci.get('hometunnel', 'global', 'domain')) return 3;
		if (!this.oauthOk) return 4;
		if (this.ingressCount < 1) return 5;
		if (!this.dnsOk) return 6;
		if (!this.workerOk) return 7;
		return 8;
	},

	renderInner: function () {
		var step = this.getStep();
		var container = htui.apply(E('div', {}, [
			E('h2', {}, _('HomeTunnel Wizard')),
			E('div', {
				'class': 'd-flex align-items-center flex-wrap',
				'style': 'gap:.5rem;padding:.6rem 1rem;border-radius:.5rem;'
					+ 'background:linear-gradient(rgba(52,140,212,.14),rgba(52,140,212,.14)),rgba(54,64,74,.9);'
					+ 'border:1px solid rgba(52,140,212,.3);'
					+ 'color:inherit'
			}, [
				E('span', { 'class': 'dripicons-information', 'style': 'font-size:16px;margin-right:8px;color:#348cd4' }),
				_('Free Cloudflare Tunnel setup. You need: a Cloudflare account and a domain hosted on Cloudflare (NS on Cloudflare).')
				])
				]));

		var titles = [
			_('① Cloudflare Authorization'),
			_('② Create Tunnel'),
			_('③ Choose Domain'),
			_('④ Authorize Switch Service'),
			_('⑤ Ingress Rules'),
			_('⑥ Publish DNS'),
			_('⑦ Deploy Switch Service'),
			_('⑧ Verify & Finish')
		];

		/* 步骤指示器（stepper）: 已完成=绿勾徽章 / 当前=蓝胶囊 / 未到=灰。
		 * 配色对齐主题: badge-soft-success(#78c350 on 18% green) + 主题蓝 #348cd4 + 卡片深底。
		 * 标题自带 ①-⑧ 编号，不再重复加数字；箭头与后续胶囊绑成单元，换行时成对移动 */
		var stepBar = E('div', {
			'class': 'd-flex align-items-center flex-wrap',
			'style': 'gap:.3rem;padding:.5rem .65rem;border-radius:.5rem;'
				+ 'background:rgba(54,64,74,.9);border:1px solid rgba(255,255,255,.07)'
		});
		titles.forEach(function (t, i) {
			var done = i < step - 1;
			var active = i === step - 1;
			var pill = E('span', {
				'class': 'd-inline-flex align-items-center',
				'style': 'gap:.3rem;padding:.22rem .6rem;border-radius:999px;font-size:12.5px;white-space:nowrap;'
					+ (done
						? 'color:#78c350;background-color:rgba(120,195,80,.18);'
						: active
							? 'color:#fff;background-color:#348cd4;font-weight:600;'
							: 'color:rgba(148,160,173,.55);background-color:rgba(255,255,255,.05);')
			}, [
				done ? E('span', { 'class': 'dripicons-checkmark', 'style': 'font-size:12px' }) : null,
				E('span', {}, t)
			].filter(Boolean));
			if (i === 0) {
				stepBar.appendChild(pill);
			} else {
				/* 连接箭头：通向已完成步骤的段绿色，否则暗灰；与胶囊绑成整体防孤行 */
				stepBar.appendChild(E('span', { 'class': 'd-inline-flex align-items-center', 'style': 'white-space:nowrap' }, [
					E('span', {
						'class': 'dripicons-arrow-thin-right',
						'style': 'font-size:11px;margin:0 .2rem;color:' + (i < step ? '#78c350' : 'rgba(148,160,173,.35)')
					}),
					pill
				]));
			}
		});
		container.appendChild(stepBar);

		var body = E('div', { 'class': 'cbi-section' });
		container.appendChild(body);

		switch (step) {
			case 1: this.step1(body); break;
			case 2: this.step2(body); break;
			case 3: this.step3(body); break;
			case 4: this.step4(body); break;
			case 5: this.step5(body); break;
			case 6: this.step6(body); break;
			case 7: this.step7(body); break;
			case 8: this.step8(body); break;
		}

		return container;
	},

	/* ---- 步骤 1: cloudflared tunnel login ---- */
	step1: function (body) {
		body.appendChild(E('p', {}, [
			_('The router runs %s and shows an authorization URL.').format('cloudflared tunnel login'), ' ',
			_('Open it on any device, log into Cloudflare, pick your domain and authorize.')
		]));

		var urlBox = E('div', { 'class': 'cbi-value', 'style': 'word-break:break-all' }, _('waiting for auth URL…'));
		var startBtn = E('button', { 'class': 'btn cbi-button cbi-button-apply important' }, _('Start Login'));
		var self = this;

		startBtn.addEventListener('click', function (ev) {
			ev.preventDefault();
			startBtn.disabled = true;
			fs.exec(HT, ['job', 'login', HT, 'login']).then(function () {
				poll.add(L.bind(self.watchLogin, self, urlBox), 2);
			});
		});
		body.appendChild(E('div', { 'style': 'margin:10px 0' }, [startBtn]));
		body.appendChild(urlBox);
	},

	watchLogin: function (urlBox) {
		var self = this;
		return jobOut('login').then(function (text) {
			var url = extractAuthUrl(text);
			if (url && !urlBox.dataset.filled) {
				urlBox.dataset.filled = '1';
				urlBox.innerHTML = '';
				urlBox.appendChild(E('a', { 'href': url, 'target': '_blank' }, url));
			}
			/* 完成检测: cert.pem 出现 */
			return fs.stat('/etc/hometunnel/.cloudflared/cert.pem').then(function (st) {
				if (st && st.size > 0) {
					urlBox.appendChild(E('div', { 'class': 'alert-message success' }, _('Authorized! Loading next step…')));
					window.setTimeout(function () { location.reload(); }, 1200);
					return;
				}
				return self.reportLoginFailure(urlBox, text);
			}).catch(function () {
				return self.reportLoginFailure(urlBox, text);
			});
		});
	},

	/* job 已退出但 cert 未到 → 显示错误并停止轮询 */
	reportLoginFailure: function (urlBox, text) {
		return jobPoll('login').then(function (st) {
			if (st.state === 'done' && st.rc !== 0 && !urlBox.dataset.failed) {
				urlBox.dataset.failed = '1';
				var tail = (text || '').trim().split('\n').slice(-3).join('\n');
				urlBox.appendChild(E('div', { 'class': 'alert-message error' }, [
					E('div', {}, _('cloudflared exited before the certificate was fetched:')),
					E('pre', { 'style': 'white-space:pre-wrap;margin:4px 0;font-size:12px' }, tail),
					E('div', {}, _('Fix the issue (e.g. router DNS), reload this page and try again.'))
				]));
			}
			if (urlBox.dataset.failed)
				return Promise.reject('login job failed');
		});
	},

	/* ---- 步骤 2: tunnel create ---- */
	step2: function (body) {
		body.appendChild(E('p', {},
			_('Create the tunnel on your Cloudflare account (uses the authorization from step ①).')));

		var self = this;
		var warn = E('div', { 'class': 'alert-message warning', 'style': 'display:none' });
		body.appendChild(warn);

		/* CF 侧状态预检: tunnel 被删/凭据失效时提示自动恢复 */
		fs.exec(HT, ['check']).then(function (res) {
			var st = ((res.stdout || '') + (res.stderr || '')).match(/cf-tunnel:\s+(\S+)/);
			var state = st ? st[1] : '';
			if (state === 'missing' || state === 'auth-failed') {
				warn.style.display = '';
				warn.appendChild(E('div', {}, state === 'missing'
					? _('The tunnel was deleted on Cloudflare. Clicking Create below will recreate it automatically (new tunnel id, DNS routes re-published in step ⑥).')
					: _('Cloudflare rejected the saved certificate. Re-run step ① first.')));
			}
		});

		var name = uci.get('hometunnel', 'global', 'tunnel_name') || 'hometunnel';
		body.appendChild(E('p', {}, E('code', {}, name)));

		var btn = E('button', { 'class': 'btn cbi-button cbi-button-apply important' }, _('Create Tunnel'));
		var out = E('pre', { 'style': 'max-height:150px;overflow:auto;font-size:12px' }, '');
		btn.addEventListener('click', function (ev) {
			ev.preventDefault();
			btn.disabled = true;
			out.textContent = 'running…';
			fs.exec(HT, ['create']).then(function (res) {
				out.textContent = (res.stdout || '') + (res.stderr || '');
				if (res.code === 0) {
					out.appendChild(E('div', { 'class': 'alert-message success' }, _('Created! Loading next step…')));
					window.setTimeout(function () { location.reload(); }, 1200);
				} else {
					btn.disabled = false;
				}
			});
		});
		body.appendChild(E('div', { 'style': 'margin:10px 0' }, [btn]));
		body.appendChild(out);
	},

	/* ---- 步骤 3: 选择域名（cert.pem token 反查账户 zone 列表）---- */
	step3: function (body) {
		var self = this;
		body.appendChild(E('p', {},
			_('Pick the domain for your tunnel hostnames (fetched automatically from your Cloudflare account).')));

		var sel = E('select', { 'class': 'cbi-input-select' });
		var loadBtn = E('button', { 'class': 'btn cbi-button cbi-button-apply important' }, _('Fetch Domains'));
		var applyBtn = E('button', { 'class': 'btn cbi-button cbi-button-save important', 'style': 'display:none' }, _('Save Domain'));
		var out = E('pre', { 'style': 'max-height:120px;overflow:auto;font-size:12px' }, '');

		loadBtn.addEventListener('click', function (ev) {
			ev.preventDefault();
			loadBtn.disabled = true;
			sel.innerHTML = '';
			sel.appendChild(E('option', { 'value': '' }, _('loading…')));
			fs.exec(HT, ['zones']).then(function (res) {
				var text = (res.stdout || '') + (res.stderr || '');
				sel.innerHTML = '';
				if (res.code === 0) {
					var lines = text.trim().split('\n').filter(Boolean);
					lines.forEach(function (l) {
						var parts = l.trim().split(/\s+/);
						sel.appendChild(E('option', { 'value': parts[0] },
							parts[0] + (parts[1] ? ' (' + parts[1] + ')' : '')));
					});
					if (lines.length > 0) {
						sel.style.display = '';
						applyBtn.style.display = '';
						loadBtn.textContent = _('Refetch');
					}
				} else {
					sel.style.display = 'none';
					out.textContent = text;
				}
				loadBtn.disabled = false;
			});
		});

		applyBtn.addEventListener('click', function (ev) {
			ev.preventDefault();
			var d = sel.value;
			if (!d) return;
			applyBtn.disabled = true;
			fs.exec(HT, ['set', 'domain', d]).then(function (res) {
				if (res.code === 0) {
					out.appendChild(E('div', { 'class': 'alert-message success' }, _('Saved! Loading next step…')));
					window.setTimeout(function () { location.reload(); }, 1000);
				} else {
					applyBtn.disabled = false;
					out.textContent = (res.stdout || '') + (res.stderr || '');
				}
			});
		});

		body.appendChild(E('div', { 'style': 'margin:10px 0' }, [loadBtn]));
		body.appendChild(E('div', { 'style': 'margin:6px 0' }, [sel, ' ', applyBtn]));
		sel.style.display = 'none';
		body.appendChild(out);
	},

	/* ---- 步骤 4: 授权开关服务（OAuth 设备流，一次扫码）---- */
	step4: function (body) {
		var self = this;
		body.appendChild(E('p', {}, [
			_('Authorize the router to deploy the switch service (a Cloudflare Worker) on your behalf.'), ' ',
			_('Scan the QR code with your phone, or open the link, then tap Allow — that is the only manual step.')
		]));

		var btn = E('button', { 'class': 'btn cbi-button cbi-button-apply important' }, _('Start Authorization'));
		var box = E('div', { 'class': 'cbi-value', 'style': 'margin-top:8px' }, '');
		btn.addEventListener('click', function (ev) {
			ev.preventDefault();
			btn.disabled = true;
			box.innerHTML = '';
			fs.exec(HT, ['oauth-start']).then(function (res) {
				var text = ((res.stdout || '') + (res.stderr || '')).trim();
				if (res.code !== 0) {
					box.appendChild(E('div', { 'class': 'alert-message error' }, _('Failed: %s').format(text)));
					btn.disabled = false;
					return;
				}
				var m = text.match(/\{[^}]*"user_code"[^}]*\}/);
				var info = null;
				try { info = JSON.parse(m ? m[0] : text); } catch (e) {}
				if (info && info.already_authorized) {
					box.appendChild(E('div', { 'class': 'alert-message success' }, _('Already authorized! Loading next step…')));
					window.setTimeout(function () { location.reload(); }, 1000);
					return;
				}
				if (!info || !info.verification_url) {
					box.appendChild(E('div', { 'class': 'alert-message error' }, _('Unexpected response: %s').format(text)));
					btn.disabled = false;
					return;
				}
				/* 授权卡片: 二维码（有则显示）+ 链接 + 等待状态 */
				var card = E('div', { 'style': 'display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap' });
				fs.read_direct(RUNDIR + '/oauth-qr.svg').then(function (svg) {
					if (svg && svg.length > 100) {
						var holder = E('div', {
							'style': 'background:#fff;padding:6px;border-radius:8px;width:172px;height:172px;flex:none'
						});
						holder.innerHTML = svg;
						card.appendChild(holder);
					}
				}).catch(function () {});
				var right = E('div', { 'style': 'flex:1;min-width:220px' });
				right.appendChild(E('div', { 'style': 'word-break:break-all;margin-bottom:6px' }, [
					E('a', { 'href': info.verification_url, 'target': '_blank' }, info.verification_url)
				]));
				right.appendChild(E('div', { 'class': 'cbi-section-descr' },
					_('The page is served by Cloudflare and may show "Wrangler" — that is Cloudflare\'s official CLI identity and is expected.')));
				var status = E('div', { 'style': 'margin-top:8px' }, _('Waiting for authorization…'));
				right.appendChild(status);
				card.appendChild(right);
				box.appendChild(card);
				/* 轮询授权状态 */
				poll.add(L.bind(self.watchOauth, self, status));
			});
		});
		body.appendChild(E('div', { 'style': 'margin:10px 0' }, [btn]));
		body.appendChild(box);
	},

	watchOauth: function (statusEl) {
		return fs.exec(HT, ['oauth-status']).then(function (res) {
			var text = (res.stdout || '').trim();
			var st = null;
			try { st = JSON.parse(text); } catch (e) {}
			if (!st) return;
			if (st.state === 'authorized') {
				statusEl.innerHTML = '';
				statusEl.appendChild(E('div', { 'class': 'alert-message success' }, _('Authorized! Loading next step…')));
				window.setTimeout(function () { location.reload(); }, 1000);
				return;
			}
			if (st.state === 'expired') {
				statusEl.innerHTML = '';
				statusEl.appendChild(E('div', { 'class': 'alert-message error' }, _('The code expired (5 minutes). Click Start Authorization again.')));
				return;
			}
			if (st.state === 'failed') {
				statusEl.innerHTML = '';
				statusEl.appendChild(E('div', { 'class': 'alert-message error' }, _('Failed: %s').format(st.error || 'unknown')));
				return;
			}
			/* pending — 继续轮询 */
		});
	},

	/* ---- 步骤 5: ingress 规则 ---- */
	step5: function (body) {
		body.appendChild(E('p', {},
			_('Add at least one service to open to the public internet. Add it in the "Ingress Rules" tab, then come back here.')));
		body.appendChild(E('a', {
			'class': 'btn cbi-button cbi-button-apply important',
			'style': 'margin-top:6px',
			'href': L.url('admin', 'services', 'hometunnel', 'ingress')
		}, _('Open Ingress Rules')));
	},

	/* ---- 步骤 6: route dns ---- */
	step6: function (body) {
		var self = this;

		body.appendChild(E('p', {},
			_('Publish a CNAME <subdomain>.<domain> → tunnel for every enabled ingress rule (uses cert.pem, no API token).')));

		var btn = E('button', { 'class': 'btn cbi-button cbi-button-apply important' }, _('Publish DNS'));
		var out = E('pre', { 'style': 'max-height:150px;overflow:auto;font-size:12px' }, '');
		btn.addEventListener('click', function (ev) {
			ev.preventDefault();
			btn.disabled = true;
			out.textContent = 'running…';
			fs.exec(HT, ['job', 'route', HT, 'route']).then(function () {
				poll.add(L.bind(self.watchRoute, self, out), 2);
			});
		});
		body.appendChild(E('div', { 'style': 'margin:10px 0' }, [btn]));
		body.appendChild(out);
	},

	watchRoute: function (outEl) {
		return jobPoll('route').then(function (st) {
			return jobOut('route').then(function (text) {
				outEl.textContent = text || '';
				if (st.state === 'done') {
					if (st.rc === 0) {
						fs.exec(HT, ['mark', 'dns-routed']);
						outEl.appendChild(E('div', { 'class': 'alert-message success' }, _('Done! Reloading…')));
						window.setTimeout(function () { location.reload(); }, 1200);
					} else {
						outEl.appendChild(E('div', { 'class': 'alert-message error' }, _('Some rules failed — check output above')));
					}
					return Promise.reject('done');
				}
			});
		});
	},

	/* ---- 步骤 7: 自动部署开关服务（OAuth token + 路由器内 curl）---- */
	/* 子域名可编辑 + 完整域名实时预览；冲突时提示（可改子域名或强制接管） */
	step7: function (body) {
		var self = this;
		var domain = uci.get('hometunnel', 'global', 'domain');
		var savedHost = uci.get('hometunnel', 'global', 'ctl_hostname') || 'ctl';
		var ctlHost = savedHost + '.' + domain;
		body.appendChild(E('p', {}, [
			_('Deploy the switch service (a Cloudflare Worker) to your subdomain of %s.').format(domain), ' ',
			_('Fully automatic from the router, no computer or Node.js needed.')
		]));

		/* 子域名输入 + 完整域名实时预览（msgid 不带尾空格——LuCI 翻译查找会修剪，
		   尾空格导致哈希不匹配；整句 %s 翻译同时避免 .format(element) 陷阱） */
		var preview = E('div', { 'style': 'margin:4px 0 10px 0' },
			_('Full name: %s').format(ctlHost));
		var input = E('input', { 'type': 'text', 'value': savedHost,
			'class': 'cbi-input-text', 'style': 'width:140px' });
		input.addEventListener('input', function () {
			var v = input.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
			preview.textContent = _('Full name: %s').format((v || 'ctl') + '.' + domain);
		});
		body.appendChild(E('div', { 'style': 'margin:6px 0' }, [
			E('label', { 'style': 'margin-right:6px' }, _('Switch subdomain')), input
		]));
		body.appendChild(preview);

		var btn = E('button', { 'class': 'btn cbi-button cbi-button-apply important' }, _('Deploy Now'));
		var out = E('pre', { 'style': 'max-height:220px;overflow:auto;font-size:12px' }, '');
		var warn = E('div', { 'class': 'alert-message warning', 'style': 'display:none' });

		/* 保存子域名后部署（值未变时 set 幂等成功） */
		var saveAndDeploy = function (args) {
			var host = input.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
			if (!host) host = 'ctl';
			fs.exec(HT, ['set', 'ctl_hostname', host]).then(function () {
				startDeploy(args);
			}).catch(function () {
				startDeploy(args);
			});
		};

		var startDeploy = function (args) {
			btn.disabled = true;
			warn.style.display = 'none';
			out.textContent = 'deploying…';
			fs.exec(HT, ['job', 'oauth-deploy', HT, 'oauth-deploy'].concat(args || [])).then(function () {
				poll.add(L.bind(self.watchDeploy, self, out, btn), 2);
			});
		};

		/* 冲突（挂在其他 Worker）: 可改子域名重试，或确认强制接管 */
		var showConflict = function (st) {
			out.textContent = '';
			warn.innerHTML = '';
			warn.style.display = '';
			warn.appendChild(E('div', {}, [
				_('The switch domain %s is already bound to another service (Worker “%s”).').format(preview.textContent, st.by)
			]));
			warn.appendChild(E('div', { 'style': 'margin-top:6px' },
				_('You can type a different subdomain above and retry, or take over the domain (this unbinds it from that service).')));
			var yes = E('button', { 'class': 'btn cbi-button cbi-button-apply important', 'style': 'margin-top:8px' },
				_('Take Over and Deploy'));
			var no = E('button', { 'class': 'btn cbi-button', 'style': 'margin-top:8px;margin-left:8px' },
				_('Cancel'));
			yes.addEventListener('click', function (ev2) {
				ev2.preventDefault();
				saveAndDeploy(['takeover']);
			});
			no.addEventListener('click', function (ev2) {
				ev2.preventDefault();
				warn.style.display = 'none';
				btn.disabled = false;
			});
			warn.appendChild(E('div', {}, [yes, no]));
		};

		/* 冲突（已有普通 DNS 记录）: 改子域名，或去 dashboard 删记录 */
		var showDnsConflict = function (st) {
			out.textContent = '';
			warn.innerHTML = '';
			warn.style.display = '';
			warn.appendChild(E('div', {}, [
				_('The switch domain %s already has a %s DNS record.').format(preview.textContent, st.by)
			]));
			warn.appendChild(E('div', { 'style': 'margin-top:6px' },
				_('Pick a different subdomain above and retry, or delete that record in the Cloudflare dashboard (DNS app) first.')));
			var no = E('button', { 'class': 'btn cbi-button', 'style': 'margin-top:8px' },
				_('Cancel'));
			no.addEventListener('click', function (ev2) {
				ev2.preventDefault();
				warn.style.display = 'none';
				btn.disabled = false;
			});
			warn.appendChild(no);
		};

		btn.addEventListener('click', function (ev) {
			ev.preventDefault();
			btn.disabled = true;
			out.textContent = 'checking…';
			/* 预检: 冲突 → 提示（可改子域名或强制接管）；干净 → 保存后直接部署 */
			fs.exec(HT, ['deploy-check']).then(function (res) {
				var st = null;
				try { st = JSON.parse((res.stdout || '').trim()); } catch (e) {}
				if (st && st.state === 'conflict' && st.kind === 'worker') {
					showConflict(st);
					return;
				}
				if (st && st.state === 'conflict' && st.kind === 'dns') {
					showDnsConflict(st);
					return;
				}
				/* clean / 预检失败（后端会给出权威错误）→ 保存子域名后部署 */
				saveAndDeploy([]);
			}).catch(function () {
				saveAndDeploy([]);
			});
		});
		body.appendChild(E('div', { 'style': 'margin:10px 0' }, [btn]));
		body.appendChild(warn);
		body.appendChild(out);

		body.appendChild(E('p', { 'class': 'cbi-section-descr' }, [
			_('Prefer a computer? The classic bundle is still available: run %s on the router and follow the README inside.').format('hometunnel.sh bundle')
		]));
	},
	watchDeploy: function (outEl, btn) {
		return jobPoll('oauth-deploy').then(function (st) {
			return jobOut('oauth-deploy').then(function (text) {
				outEl.textContent = text || '';
				if (st.state === 'done') {
					if (st.rc === 0) {
						fs.exec(HT, ['mark', 'worker-deployed']);
						outEl.appendChild(E('div', { 'class': 'alert-message success' }, _('Deployed! Loading next step…')));
						window.setTimeout(function () { location.reload(); }, 1200);
					} else {
						outEl.appendChild(E('div', { 'class': 'alert-message error' }, _('Deploy failed — check output above')));
						btn.disabled = false;
					}
					return Promise.reject('done');
				}
			});
		});
	},

	/* ---- 步骤 8: verify + finish ---- */
	step8: function (body) {
		var mode = uci.get('hometunnel', 'global', 'mode') || 'ondemand';
		body.appendChild(E('p', {},
			_('Verify the remote switch from the router, then enable the daemon and go to the status page.')));

		var btn = E('button', { 'class': 'btn cbi-button cbi-button-apply important' }, _('Verify'));
		var out = E('pre', { 'style': 'max-height:150px;overflow:auto;font-size:12px' }, '');
		btn.addEventListener('click', function (ev) {
			ev.preventDefault();
			btn.disabled = true;
			out.textContent = 'verifying…';
			fs.exec(HT, ['verify']).then(function (res) {
				out.textContent = (res.stdout || '') + (res.stderr || '');
				if (res.code === 0) {
					fs.exec(HT, ['mark', 'worker-verified']).then(function () {
						return fs.exec(HT, ['apply-mode']);
					}).then(function () {
						out.appendChild(E('div', { 'class': 'alert-message success' },
							_('All checks passed. Daemon enabled. Opening status page…')));
						window.setTimeout(function () {
							location.href = L.url('admin', 'services', 'hometunnel', 'status');
						}, 1500);
					});
				} else {
					btn.disabled = false;
				}
			});
		});
		body.appendChild(E('div', { 'style': 'margin:10px 0' }, [btn]));
		body.appendChild(out);

		body.appendChild(E('p', { 'class': 'cbi-section-descr' }, [
			_('Mode: %s — change it later in Settings.').format(mode)
		]));
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
