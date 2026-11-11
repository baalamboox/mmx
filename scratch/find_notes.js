const fs = require('fs');
const content = fs.readFileSync('public/app.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, i) => {
  if (line.includes('/api/note')) {
    console.log((i+1) + ': ' + line.trim());
  }
});
