/* SPDX-License-Identifier: Apache-2.0 */
/* Copyright (C) 2026 xiaoqingfeng <xiaoqingfeng@yeah.net> */
/* hometunnel ingress — 接入规则（UCI → config.yml） */

'use strict';
'require form';
'require fs';
'require uci';
'require view';
'require view.hometunnel.ui as htui';

return view.extend({
	render: function () {
		var m, s, o;

		m = new form.Map('hometunnel', _('HomeTunnel — Ingress Rules'),
			_('Each rule exposes one intranet service as <code>subdomain.domain</code> via the tunnel. Unmatched hostnames/paths always return 404.'));

		s = m.section(form.GridSection, 'ingress', _('Rules'));
		s.addremove = true;
		s.anonymous = true;
		s.sortable = true;
		s.nodescriptions = true;

		o = s.option(form.Flag, 'enabled', _('Enabled'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'name', _('Name'));
		o.placeholder = 'nas';
		o.rmempty = false;

		o = s.option(form.Value, 'subdomain', _('Subdomain'));
		o.placeholder = 'nas';
		o.datatype = 'and(minlength(1),hostname)';
		o.rmempty = false;

		o = s.option(form.Value, 'service', _('Service URL'),
			_('cloudflared service syntax, e.g. <code>http://192.168.1.10:5000</code>, <code>ssh://192.168.1.10:22</code>, <code>tcp://…</code>'));
		o.placeholder = 'http://192.168.1.10:5000';
		o.rmempty = false;

		o = s.option(form.Value, 'path', _('Path regex'),
			_('Optional. Only forward matching paths, e.g. <code>^/api(/.*)?$</code>'));
		o.placeholder = '^/api(/.*)?$';
		o.rmempty = true;

		o = s.option(form.Value, 'http_host_header', _('Origin Host header'),
			_('Optional. Rewrite the Host header sent to the origin (needed behind a name-based reverse proxy).'));
		o.placeholder = 'nas.local';
		o.rmempty = true;

		o = s.option(form.Flag, 'no_tls_verify', _('Skip TLS verify'),
			_('Skip certificate verification for https origins (self-signed certs).'));
		o.rmempty = true;

		o = s.option(form.Value, 'connect_timeout', _('Connect timeout (s)'));
		o.placeholder = '30';
		o.datatype = 'uinteger';
		o.rmempty = true;

		/* form.Map 页: Save&Apply 下拉等元素也缺主题样式, 包一层挂作用域 */
		return m.render().then(function (node) { return htui.apply(node); });
	},

	/* 保存并应用后: 增量发布 DNS CNAME → 重建 config.yml → 平滑重启数据面。
	   uci-applied 由 ui.js apply 轮询成功时派发（apply_display 秒后整页刷新，
	   窗口内执行）; route 幂等，已有 CNAME 跳过 */
	load: function () {
		var HT = '/usr/share/hometunnel/hometunnel.sh';
		var self = this;
		document.addEventListener('uci-applied', function () {
			/* 绑定完成才有远端可发布; 未绑定时只 regen（向导会在部署时统一发布） */
			fs.exec(HT, ['probe']).then(function (res) {
				var st = null;
				try { st = JSON.parse((res.stdout || '').trim()); } catch (e) {}
				if (st && st.bound) {
					fs.exec(HT, ['job', 'route', HT, 'route']);
				}
				return fs.exec(HT, ['regen']);
			}).catch(function () {});
		});
		return uci.load('hometunnel');
	}
});
