#!/usr/bin/env node
/* 找出 msgid 列表中 po 未收录的条目 */
const fs = require('fs');
const ids = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const po = fs.readFileSync(process.argv[3], 'utf8');
const esc = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const miss = ids.filter(id => !po.includes(`msgid "${esc(id)}"`));
console.log(miss.join('\n'));
console.log('---COUNT---', miss.length);
