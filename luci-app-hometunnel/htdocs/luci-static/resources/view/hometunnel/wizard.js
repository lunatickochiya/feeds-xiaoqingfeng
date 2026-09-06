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

	render: function (data) {
		var self = this;
		this.uciData = data;

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
		var cfg = this.uciData;
		if (!this.certOk) return 1;
		if (!cfg.get('hometunnel', 'global', 'tunnel_id')) return 2;
		if (this.ingressCount < 1) return 3;
		if (!this.dnsOk) return 4;
		if (!this.workerOk) return 5;
		return 6;
	},

	renderInner: function () {
		var step = this.getStep();
		var container = E('div', {}, [
			E('h2', {}, _('HomeTunnel Wizard')),
			E('div', { 'class': 'cbi-section-descr' },
				_('Free Cloudflare Tunnel setup. You need: a Cloudflare account and a domain hosted on Cloudflare (NS on Cloudflare).'))
		]);

		var titles = [
			_('① Cloudflare Authorization'),
			_('② Create Tunnel'),
			_('③ Ingress Rules'),
			_('④ Publish DNS'),
			_('⑤ Control-plane Worker'),
			_('⑥ Verify & Finish')
		];

		container.appendChild(E('ol', { 'style': 'margin:8px 0 16px 0;padding-left:20px' },
			titles.map(function (t, i) {
				return E('li', {
					'style': 'font-weight:' + (i === step - 1 ? 'bold' : 'normal') +
						';color:' + (i < step - 1 ? 'green' : 'inherit')
				}, t);
			})
		));

		var body = E('div', { 'class': 'cbi-section' });
		container.appendChild(body);

		switch (step) {
			case 1: this.step1(body); break;
			case 2: this.step2(body); break;
			case 3: this.step3(body); break;
			case 4: this.step4(body); break;
			case 5: this.step5(body); break;
			case 6: this.step6(body); break;
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
				}
			}).catch(function () { /* not yet */ });
		});
	},

	/* ---- 步骤 2: tunnel create ---- */
	step2: function (body) {
		body.appendChild(E('p', {},
			_('Create the tunnel on your Cloudflare account (uses the authorization from step ①).')));

		var name = this.uciData.get('hometunnel', 'global', 'tunnel_name') || 'hometunnel';
		body.appendChild(E('p', {}, E('code', {}, name)));

		var btn = E('button', { 'class': 'btn cbi-button cbi-button-apply important' }, _('Create Tunnel'));
		var out = E('pre', { 'style': 'max-height:150px;overflow:auto;font-size:12px' }, '');
		btn.addEventListener('click', function (ev) {
			ev.preventDefault();
			btn.disabled = true;
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

	/* ---- 步骤 3: ingress 规则 ---- */
	step3: function (body) {
		body.appendChild(E('p', {},
			_('Add at least one service to expose. Continue in the Ingress Rules page, then come back.')));
		body.appendChild(E('a', {
			'class': 'btn cbi-button cbi-button-apply important',
			'href': L.url('admin', 'services', 'hometunnel', 'ingress')
		}, _('Open Ingress Rules')));
	},

	/* ---- 步骤 4: route dns ---- */
	step4: function (body) {
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

	/* ---- 步骤 5: worker bundle ---- */
	step5: function (body) {
		var domain = this.uciData.get('hometunnel', 'global', 'domain');
		body.appendChild(E('p', {}, [
			_('Download the deployment bundle, extract it on a computer with Node.js, and run <code>./deploy.sh</code>. ') +
			_('This deploys the control-plane Worker to <code>%s.%s</code> (custom domain, free tier).')
				.format(this.uciData.get('hometunnel', 'global', 'ctl_hostname') || 'ctl', domain)
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

	/* ---- 步骤 6: verify + finish ---- */
	step6: function (body) {
		var mode = this.uciData.get('hometunnel', 'global', 'mode') || 'ondemand';
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
