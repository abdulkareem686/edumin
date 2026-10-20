const fs = require('fs');
const p = require('path').join(__dirname, '..', 'server.js');
let s = fs.readFileSync(p, 'utf8');
const re = /const \[tableCheck\] = await connection\.execute\(`[\s\S]*?SELECT COUNT\(\*\) as count FROM information_schema\.tables[\s\S]*?table_name = '([^']+)'[\s\S]*?`\);\s*\r?\n\s*if \(tableCheck\[0\]\.count > 0\) \{/g;
const before = (s.match(re) || []).length;
s = s.replace(re, "if (await tableExists(connection, '$1')) {");
fs.writeFileSync(p, s);
const left = (s.match(/information_schema\.tables/gi) || []).length;
console.log('replaced', before, 'remaining information_schema.tables', left);
