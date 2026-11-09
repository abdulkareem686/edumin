const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../routes/parentRoutes.js');
let content = fs.readFileSync(filePath, 'utf8');

const marker = "res.status(500).render('error', { message: 'Failed to fetch children data', error });\r\n    }\r\n});";
const markerLf = "res.status(500).render('error', { message: 'Failed to fetch children data', error });\n    }\n});";

const nextMarker = "// GET route - View specific child details";

const idx = content.indexOf(marker);
const idxLf = content.indexOf(markerLf);
const startIdx = idx !== -1 ? idx + marker.length : (idxLf !== -1 ? idxLf + markerLf.length : -1);
const endIdx = content.indexOf(nextMarker);

if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
    content = content.slice(0, startIdx) + "\n\n" + content.slice(endIdx);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Successfully removed orphaned catch block!');
} else {
    console.log('Markers not found, startIdx:', startIdx, 'endIdx:', endIdx);
}
