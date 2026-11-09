const fs = require('fs');
const path = require('path');

const routeFiles = fs.readdirSync('routes').filter(f => f.endsWith('.js')).map(f => path.join('routes', f));
routeFiles.push('server.js');

const definedRoutes = [];
for (const f of routeFiles) {
  const content = fs.readFileSync(f, 'utf8');
  const routeRegex = /(?:router|app)\.(?:get|post|put|delete|use)\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = routeRegex.exec(content)) !== null) {
    definedRoutes.push(match[1]);
  }
}

function matchesRoute(href) {
  const cleanHref = href.split('?')[0];
  for (const r of definedRoutes) {
    if (r === cleanHref) return true;
    const pattern = '^' + r.replace(/:[^\s/]+/g, '[^/]+').replace(/\?/g, '') + '$';
    if (new RegExp(pattern).test(cleanHref)) return true;
  }
  return false;
}

const partialFiles = fs.readdirSync('views/school_app/partials').filter(f => f.endsWith('.ejs')).map(f => path.join('views/school_app/partials', f));

console.log('--- AUDITING NAVIGATION PARTIALS ---');
for (const f of partialFiles) {
  const content = fs.readFileSync(f, 'utf8');
  const hrefRegex = /href=["'](\/[^"'#\s]+)/g;
  let match;
  while ((match = hrefRegex.exec(content)) !== null) {
    const link = match[1];
    if (link.startsWith('/assets') || link.startsWith('/vendor') || link.startsWith('/css') || link.startsWith('/js') || link.startsWith('/images') || link.startsWith('/uploads')) continue;
    const ok = matchesRoute(link);
    if (!ok) {
      console.log(`[BROKEN LINK] in ${f}: ${link}`);
    }
  }
}
