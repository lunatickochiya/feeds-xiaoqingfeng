/* SPDX-License-Identifier: Apache-2.0 */
/* Copyright (C) 2026 xiaoqingfeng <xiaoqingfeng@yeah.net> */
/* hometunnel wizard — 6 步断点向导（job 异步轮询） */

'use strict';
'require fs';
'require poll';
'require rpc';
'require uci';
'require view';

var HT = '/usr/share/hometunnel/hometunnel.sh';
var RUNDIR = '/var/run/hometunnel';

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
			return fs.stat(RUNDIR + '/worker-verified');
		}).then(function (st) {
			self.workerOk = !!(st && st.size > 0);
		}).catch(function () { self.workerOk = false; });
	},

	getStep: function () {
		if (!this.certOk) return 1;
		if (!uci.get('hometunnel', 'global', 'tunnel_id')) return 2;
		if (!uci.get('hometunnel', 'global', 'domain')) return 3;
		if (this.ingressCount < 1) return 4;
		if (!this.dnsOk) return 5;
		if (!this.workerOk) return 6;
		return 7;
	},

	renderInner: function () {
		var step = this.getStep();
		var container = E('div', {}, [
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
		]);

		var titles = [
			_('① Cloudflare Authorization'),
			_('② Create Tunnel'),
			_('③ Choose Domain'),
			_('④ Ingress Rules'),
			_('⑤ Publish DNS'),
			_('⑥ Control-plane Worker'),
			_('⑦ Verify & Finish')
		];

		/* 步骤指示器（stepper）: 已完成=绿勾徽章 / 当前=蓝胶囊 / 未到=灰。
		 * 配色对齐主题: badge-soft-success(#78c350 on 18% green) + 主题蓝 #348cd4 + 卡片深底。
		 * 标题自带 ①-⑦ 编号，不再重复加数字；箭头与后续胶囊绑成单元，换行时成对移动 */
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
		}

		return container;
	},

	/* ---- 步骤 1: cloudflared tunnel login ---- */
	step1: function (body) {
		body.appendChild(E('p', {}, [
			_('The router runs <code>cloudflared tunnel login</code> and shows an authorization URL. ') +
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
					? _('The tunnel was deleted on Cloudflare. Clicking Create below will recreate it automatically (new tunnel id, DNS routes re-published in step ⑤).')
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

	/* ---- 步骤 4: ingress 规则 ---- */
	step4: function (body) {
		body.appendChild(E('p', {},
			_('Add at least one service to open to the public internet. Add it in the "Ingress Rules" tab, then come back here.')));
		/* 主题 CSS 未定义 .cbi-button-apply（那套类是给 <button> 的），<a> 会渲染成裸链接。
		 * 用主题 Bootstrap 的 .btn-primary 配方（#348cd4 实底白字）+ 白色图标 */
		body.appendChild(E('a', {
			'class': 'btn btn-primary d-inline-flex align-items-center',
			'style': 'gap:.35rem;text-decoration:none;margin-top:6px',
			'href': L.url('admin', 'services', 'hometunnel', 'ingress')
		}, [
			E('span', { 'class': 'dripicons-arrow-thin-right', 'style': 'font-size:13px' }),
			_('Open Ingress Rules')
		]));
	},

	/* ---- 步骤 5: route dns ---- */
	step5: function (body) {
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

	/* ---- 步骤 6: worker bundle ---- */
	step6: function (body) {
		var domain = uci.get('hometunnel', 'global', 'domain');
		body.appendChild(E('p', {}, [
			_('Download the deployment bundle, extract it on a computer with Node.js, and run <code>./deploy.sh</code>. ') +
			_('This deploys the control-plane Worker to <code>%s.%s</code> (custom domain, free tier).')
				.format(uci.get('hometunnel', 'global', 'ctl_hostname') || 'ctl', domain)
		]));

		var btn = E('button', { 'class': 'btn cbi-button cbi-button-apply important' }, _('Generate Bundle'));
		var link = E('a', { 'class': 'btn cbi-button', 'style': 'display:none' }, _('Download'));
		btn.addEventListener('click', function (ev) {
			ev.preventDefault();
			btn.disabled = true;
			fs.exec(HT, ['bundle']).then(function (res) {
				var path = (res.stdout || '').trim().split('\n').pop();
				if (res.code === 0 && path && path.indexOf('/tmp/') === 0) {
					/* cgi-download 表单提交（flash.js 同款范式） */
					var form = E('form', {
						'method': 'post',
						'action': L.env.cgi_base + '/cgi-download',
						'enctype': 'application/x-www-form-urlencoded',
						'style': 'display:none'
					}, [
						E('input', { 'type': 'hidden', 'name': 'sessionid', 'value': rpc.getSessionID() }),
						E('input', { 'type': 'hidden', 'name': 'path', 'value': path }),
						E('input', { 'type': 'hidden', 'name': 'filename', 'value': path.split('/').pop() })
					]);
					document.body.appendChild(form);
					form.submit();
					document.body.removeChild(form);
					btn.textContent = _('Bundle ready — download below');
					link.onclick = function () {
						document.body.appendChild(form);
						form.submit();
						document.body.removeChild(form);
						return false;
					};
					link.style.display = '';
				} else {
					btn.textContent = _('Failed: %s').format((res.stderr || res.stdout || 'unknown').trim());
					btn.disabled = false;
				}
			});
		});
		body.appendChild(E('div', { 'style': 'margin:10px 0' }, [btn, ' ', link]));

		body.appendChild(E('p', { 'class': 'cbi-section-descr' },
			_('On your computer: <code>tar xzf hometunnel-worker-%s.tar.gz && cd hometunnel-worker && ./deploy.sh</code>').format(domain)));

		var doneBtn = E('button', { 'class': 'btn cbi-button cbi-button-apply important' }, _("I've deployed — Continue"));
		doneBtn.addEventListener('click', function (ev) {
			ev.preventDefault();
			fs.exec(HT, ['mark', 'worker-deployed']).then(function () { location.reload(); });
		});
		body.appendChild(E('div', { 'style': 'margin:10px 0' }, [doneBtn]));
	},

	/* ---- 步骤 7: verify + finish ---- */
	step7: function (body) {
		var mode = uci.get('hometunnel', 'global', 'mode') || 'ondemand';
		body.appendChild(E('p', {},
			_('Verify the control plane from the router, then enable the daemon and go to the status page.')));

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

		body.appendChild(E('p', { 'class': 'cbi-section-descr' },
			_('Mode: <code>%s</code> — change it later in Settings.').format(mode)));
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
