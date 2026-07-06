const fs = require('fs');
const path = require('path');

function fixJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  // Replace ALL literal newlines/carriage returns/tabs within the entire file
  // by splitting on quote marks, fixing only odd-indexed segments (string values)
  const parts = raw.split('"');
  for (let i = 1; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/\r\n/g, '\\n').replace(/\n/g, '\\n').replace(/\r/g, '\\n').replace(/\t/g, '\\t');
  }
  const fixed = parts.join('"');
  try {
    const parsed = JSON.parse(fixed);
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error(filePath, e.message.substring(0, 100));
    return false;
  }
}

const dir = path.resolve(__dirname, '../agents');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== '_registry.json');
for (const f of files) {
  const p = path.join(dir, f);
  console.log(f, fixJsonFile(p) ? 'OK' : 'FAIL');
}
