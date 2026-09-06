#!/usr/bin/env node
/* 提取 diagram.js 的 _('...') 字符串，输出 msgid 列表 JSON */
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const re = /_\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g;
const ids = new Set();
let m;
while ((m = re.exec(src))) ids.add(m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
console.log(JSON.stringify([...ids].sort(), null, 1));
