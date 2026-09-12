/* SPDX-License-Identifier: Apache-2.0 */
/* Copyright (C) 2026 xiaoqingfeng <xiaoqingfeng@yeah.net> */
/* hometunnel ingress — 接入规则（UCI → config.yml） */

'use strict';
'require form';
'require uci';
'require view';
'require view.hometunnel.ui as htui';

return view.extend({
	render: function () {
		var m, s, o;

		m = new form.Map('hometunnel', _('HomeTunnel — Ingress Rules'),
			_('Each rule exposes one intranet service as <code>subdomain.domain</code> via the tunnel. ') +
			_('Unmatched hostnames/paths always return 404.'));

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

	/* 保存后重新生成 config.yml 并平滑重启数据面（uci-applied 事件范式，tinyproxy 同款） */
	handleSaveApply: function (ev, mode) {
		var Fn = L.bind(function () {
			fs.exec('/usr/share/hometunnel/hometunnel.sh', ['regen']);
			document.removeEventListener('uci-applied', Fn);
		}, this);
		document.addEventListener('uci-applied', Fn);
		return this.super('handleSaveApply', [ev, mode]);
	}
});
