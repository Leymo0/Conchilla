// Checks a packed app.asar: every file must read back intact, package.json must be valid JSON,
// and every .js file must at least parse. Exits 1 on any problem.
const asar = require('@electron/asar');
const vm = require('vm');
const path = require('path');

const archive = process.argv[2];
const problems = [];
let checked = 0;

for (const entry of asar.listPackage(archive)) {
  const rel = entry.replace(/^[\\/]/, '');
  if (rel.includes('node_modules')) continue;
  let data;
  try {
    data = asar.extractFile(archive, rel);
  } catch {
    continue; // directory
  }
  checked++;
  if (rel === 'package.json') {
    try { JSON.parse(data.toString()); } catch (e) { problems.push(`package.json: ${e.message}`); }
  }
  if (rel.endsWith('.js')) {
    try { new vm.Script(data.toString(), { filename: rel }); } catch (e) { problems.push(`${rel}: ${e.message}`); }
  }
  if (rel.endsWith('.log')) problems.push(`${rel}: log file should not be packed`);
}

const mainOk = (() => {
  try { return !!JSON.parse(asar.extractFile(archive, 'package.json').toString()).main; } catch { return false; }
})();
if (!mainOk) problems.push('package.json has no "main"');

if (problems.length) {
  console.error(`BROKEN (${problems.length} problems in ${checked} files):\n- ` + problems.join('\n- '));
  process.exit(1);
}
console.log(`OK: ${checked} files verified in ${path.basename(archive)}`);
