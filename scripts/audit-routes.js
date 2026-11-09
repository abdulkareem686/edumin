const fs = require('fs');
const path = require('path');

// Extract all registered routes
const routeFiles = fs.readdirSync('routes').filter(f => f.endsWith('.js')).map(f => path.join('routes', f));
routeFiles.push('server.js');

const definedRoutes = new Set();
for (const f of routeFiles) {
  const content = fs.readFileSync(f, 'utf8');
  const routeRegex = /(?:router|app)\.(get|post|put|delete|use)\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = routeRegex.exec(content)) !== null) {
    definedRoutes.add(match[2]);
  }
}

// Extract all hrefs from views
function getFiles(dir) {
  let res = [];
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) res = res.concat(getFiles(full));
    else if (f.endsWith('.ejs')) res.push(full);
  }
  return res;
}

const ejsFiles = getFiles('views');
const hrefs = new Map();
for (const f of ejsFiles) {
  const content = fs.readFileSync(f, 'utf8');
  const hrefRegex = /href=["'](\/[^"'#\s?]+)/g;
  let match;
  while ((match = hrefRegex.exec(content)) !== null) {
    const link = match[1];
    if (link.startsWith('/assets') || link.startsWith('/vendor') || link.startsWith('/css') || link.startsWith('/js') || link.startsWith('/images') || link.startsWith('/uploads')) continue;
    if (!hrefs.has(link)) hrefs.set(link, []);
    hrefs.get(link).push(f);
  }
}

console.log('--- DEFINED ROUTES COUNT:', definedRoutes.size);
console.log('--- CHECKING HREF LINKS IN VIEWS ---');
const missingRoutes = [];
for (const [link, files] of hrefs.entries()) {
  let matched = false;
  for (const r of definedRoutes) {
    if (r === link) { matched = true; break; }
    // convert express route :param to regex
    const pattern = '^' + r.replace(/:[^\s/]+/g, '[^/]+') + '$';
    if (new RegExp(pattern).test(link)) { matched = true; break; }
  }
  if (!matched) {
    missingRoutes.push({ link, files: [...new Set(files)] });
  }
}
console.log('Missing routes count:', missingRoutes.length);
missingRoutes.forEach(m => console.log(m.link, '-> referenced in:', m.files.slice(0, 3).join(', ')));
