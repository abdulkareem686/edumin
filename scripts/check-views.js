const fs = require('fs');
const path = require('path');

const routeFiles = fs.readdirSync('routes').filter(f => f.endsWith('.js')).map(f => path.join('routes', f));
routeFiles.push('server.js');

const missingViews = [];
for (const file of routeFiles) {
  const code = fs.readFileSync(file, 'utf8');
  const regex = /res\.render\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = regex.exec(code)) !== null) {
    const viewName = match[1];
    let possiblePaths = [
      path.join('views', viewName + '.ejs'),
      path.join('views', 'school_app', viewName + '.ejs'),
      path.join('views', viewName),
      path.join('views', 'school_app', viewName)
    ];
    const exists = possiblePaths.some(p => fs.existsSync(p));
    if (!exists) {
      missingViews.push({ file, viewName, line: code.substring(0, match.index).split('\n').length });
    }
  }
}
console.log('Missing views count:', missingViews.length);
console.log(JSON.stringify(missingViews, null, 2));
