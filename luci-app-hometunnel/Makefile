# SPDX-License-Identifier: Apache-2.0
#
# Copyright (C) 2026 xiaoqingfeng <xiaoqingfeng@yeah.net>
#
# LuCI for hometunnel — HomeLede Cloudflare Tunnel 内网穿透

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-hometunnel
PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=xiaoqingfeng <xiaoqingfeng@yeah.net>
PKGARCH:=all

LUCI_TITLE:=LuCI support for hometunnel
LUCI_DESCRIPTION:=HomeLede-tailored Cloudflare Tunnel intranet exposure: wizard, \
 ingress rules, on-demand control plane (Worker), auto-renew on traffic, fail-closed.
LUCI_DEPENDS:=+hometunnel

define Package/$(PKG_NAME)/conffiles
/etc/config/hometunnel
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
