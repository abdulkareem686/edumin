const fs = require('fs');
const path = require('path');

function extractBetween(src, startMarker, endMarker, inclusiveEnd = true) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error('start not found: ' + startMarker.slice(0, 40));
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error('end not found: ' + endMarker.slice(0, 40));
  return src.slice(start, inclusiveEnd ? end + endMarker.length : end);
}

const outDir = path.join('views', 'school_app', 'partials', 'forms');
fs.mkdirSync(outDir, { recursive: true });

// --- STUDENT ---
{
  const add = fs.readFileSync('views/school_app/add-student.ejs', 'utf8');
  const formHtml = extractBetween(add, '<form action="/save-student"', '</form>');
  // Create-only: strip edit-specific button branches to always show Add
  let createForm = formHtml
    .replace(/<% if \(mode === 'edit'\) \{ %>[\s\S]*?<% \} else \{ %>\s*/g, '')
    .replace(/<% \} %>\s*(?=<button type="reset"|<\/button>)/g, '')
    .replace(/<% if \(mode === 'edit' && formData\.admission_number\) \{ %>[\s\S]*?<% \} else \{ %>\s*/g, '')
    .replace(/<% \} %>\s*(?=<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<!-- Academic)/g, '');
  // Simpler: keep form as-is but ensure mode defaults for create
  // Prefer keeping original form with mode checks; list page will pass mode:'add'
  fs.writeFileSync(path.join(outDir, 'student-form-fields.ejs'), formHtml);
  const script = extractBetween(add, '<!-- JavaScript for form handling -->', '</script>');
  fs.writeFileSync(path.join(outDir, 'student-form-scripts.ejs'), script);
  console.log('student ok');
}

// --- PARENT ---
{
  const add = fs.readFileSync('views/school_app/add-parent.ejs', 'utf8');
  // find main form
  const formMatch = add.match(/<form[\s\S]*?<\/form>/);
  if (!formMatch) throw new Error('parent form not found');
  fs.writeFileSync(path.join(outDir, 'parent-form-fields.ejs'), formMatch[0]);
  // any custom scripts after form (before vendor)
  const scriptIdx = add.lastIndexOf('<script>');
  const vendorIdx = add.indexOf('vendor.min.js');
  if (scriptIdx > 0 && (vendorIdx < 0 || scriptIdx < vendorIdx)) {
    const scripts = add.slice(scriptIdx, vendorIdx > 0 ? add.lastIndexOf('</script>', vendorIdx) + 9 : add.lastIndexOf('</script>') + 9);
    // only if it's custom (not just empty)
    if (scripts.includes('DOMContentLoaded') || scripts.includes('function')) {
      fs.writeFileSync(path.join(outDir, 'parent-form-scripts.ejs'), scripts);
    }
  }
  console.log('parent ok', formMatch[0].length);
}

// --- TEACHER ---
{
  const add = fs.readFileSync('views/school_app/add-teacher.ejs', 'utf8');
  const formMatch = add.match(/<form[\s\S]*?<\/form>/);
  if (!formMatch) throw new Error('teacher form not found');
  fs.writeFileSync(path.join(outDir, 'teacher-form-fields.ejs'), formMatch[0]);
  console.log('teacher ok', formMatch[0].length);
}

// --- STAFF ---
{
  const add = fs.readFileSync('views/school_app/add-staff.ejs', 'utf8');
  const formMatch = add.match(/<form[\s\S]*?<\/form>/);
  if (!formMatch) throw new Error('staff form not found');
  fs.writeFileSync(path.join(outDir, 'staff-form-fields.ejs'), formMatch[0]);
  console.log('staff ok', formMatch[0].length);
}

// --- CLASS ---
{
  const add = fs.readFileSync('views/school_app/add-class.ejs', 'utf8');
  const formMatch = add.match(/<form[\s\S]*?<\/form>/);
  if (!formMatch) throw new Error('class form not found');
  fs.writeFileSync(path.join(outDir, 'class-form-fields.ejs'), formMatch[0]);
  // scripts
  const scripts = [];
  let idx = 0;
  while (true) {
    const s = add.indexOf('<script>', idx);
    if (s < 0) break;
    const e = add.indexOf('</script>', s);
    const block = add.slice(s, e + 9);
    if (!block.includes('src=') && (block.includes('function') || block.includes('DOMContentLoaded') || block.includes('addEventListener'))) {
      scripts.push(block);
    }
    idx = e + 9;
  }
  if (scripts.length) fs.writeFileSync(path.join(outDir, 'class-form-scripts.ejs'), scripts.join('\n'));
  console.log('class ok', formMatch[0].length, 'scripts', scripts.length);
}

// --- SUBJECTS ---
{
  const add = fs.readFileSync('views/school_app/register-subjects.ejs', 'utf8');
  const formMatch = add.match(/<form[\s\S]*?<\/form>/);
  if (!formMatch) throw new Error('subjects form not found');
  fs.writeFileSync(path.join(outDir, 'subjects-form-fields.ejs'), formMatch[0]);
  const scripts = [];
  let idx = 0;
  while (true) {
    const s = add.indexOf('<script>', idx);
    if (s < 0) break;
    const e = add.indexOf('</script>', s);
    const block = add.slice(s, e + 9);
    if (!block.includes('src=') && (block.includes('function') || block.includes('DOMContentLoaded') || block.includes('addEventListener') || block.includes('subject'))) {
      scripts.push(block);
    }
    idx = e + 9;
  }
  if (scripts.length) fs.writeFileSync(path.join(outDir, 'subjects-form-scripts.ejs'), scripts.join('\n'));
  console.log('subjects ok', formMatch[0].length, 'scripts', scripts.length);
}

// --- ACADEMIC YEAR ---
{
  const add = fs.readFileSync('views/school_app/add-academic-year.ejs', 'utf8');
  const formMatch = add.match(/<form[\s\S]*?<\/form>/);
  if (!formMatch) throw new Error('academic year form not found');
  fs.writeFileSync(path.join(outDir, 'academic-year-form-fields.ejs'), formMatch[0]);
  const scripts = [];
  let idx = 0;
  while (true) {
    const s = add.indexOf('<script>', idx);
    if (s < 0) break;
    const e = add.indexOf('</script>', s);
    const block = add.slice(s, e + 9);
    if (!block.includes('src=') && (block.includes('function') || block.includes('DOMContentLoaded') || block.includes('addEventListener'))) {
      scripts.push(block);
    }
    idx = e + 9;
  }
  if (scripts.length) fs.writeFileSync(path.join(outDir, 'academic-year-form-scripts.ejs'), scripts.join('\n'));
  console.log('academic-year ok', formMatch[0].length, 'scripts', scripts.length);
}

// --- LIBRARY ---
{
  const add = fs.readFileSync('views/school_app/add-library.ejs', 'utf8');
  const formMatch = add.match(/<form[\s\S]*?<\/form>/);
  if (!formMatch) throw new Error('library form not found');
  fs.writeFileSync(path.join(outDir, 'library-form-fields.ejs'), formMatch[0]);
  console.log('library ok', formMatch[0].length);
}

// --- EVENT ---
{
  const add = fs.readFileSync('views/school_app/add-event.ejs', 'utf8');
  const formMatch = add.match(/<form[\s\S]*?<\/form>/);
  if (!formMatch) throw new Error('event form not found');
  fs.writeFileSync(path.join(outDir, 'event-form-fields.ejs'), formMatch[0]);
  console.log('event ok', formMatch[0].length);
}

// --- CLASS BILLS (create only portion - whole form; edit uses same file with mode) ---
{
  const add = fs.readFileSync('views/school_app/class-bills-form.ejs', 'utf8');
  const formMatch = add.match(/<form[\s\S]*?<\/form>/);
  if (!formMatch) throw new Error('class bills form not found');
  fs.writeFileSync(path.join(outDir, 'class-bill-form-fields.ejs'), formMatch[0]);
  const scripts = [];
  let idx = 0;
  while (true) {
    const s = add.indexOf('<script>', idx);
    if (s < 0) break;
    const e = add.indexOf('</script>', s);
    const block = add.slice(s, e + 9);
    if (!block.includes('src=') && (block.includes('function') || block.includes('DOMContentLoaded') || block.includes('addEventListener'))) {
      scripts.push(block);
    }
    idx = e + 9;
  }
  if (scripts.length) fs.writeFileSync(path.join(outDir, 'class-bill-form-scripts.ejs'), scripts.join('\n'));
  console.log('class-bills ok', formMatch[0].length, 'scripts', scripts.length);
}

// --- BOOK LIST ---
{
  const add = fs.readFileSync('views/school_app/book-list-form.ejs', 'utf8');
  const formMatch = add.match(/<form[\s\S]*?<\/form>/);
  if (!formMatch) throw new Error('book list form not found');
  fs.writeFileSync(path.join(outDir, 'book-list-form-fields.ejs'), formMatch[0]);
  const scripts = [];
  let idx = 0;
  while (true) {
    const s = add.indexOf('<script>', idx);
    if (s < 0) break;
    const e = add.indexOf('</script>', s);
    const block = add.slice(s, e + 9);
    if (!block.includes('src=') && (block.includes('function') || block.includes('DOMContentLoaded') || block.includes('addEventListener'))) {
      scripts.push(block);
    }
    idx = e + 9;
  }
  if (scripts.length) fs.writeFileSync(path.join(outDir, 'book-list-form-scripts.ejs'), scripts.join('\n'));
  console.log('book-list ok', formMatch[0].length, 'scripts', scripts.length);
}

console.log('All extractions done');
