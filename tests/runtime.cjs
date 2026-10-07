'use strict';
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const scratch = path.join(root, '.test-work');
fs.mkdirSync(scratch, {recursive: true});
function codeExe() {
  const exe = process.env.VSCODE_EXE || path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
  if (!fs.existsSync(exe)) throw new Error('VS Code executable not found; set VSCODE_EXE.');
  return exe;
}
module.exports = {root, scratch, codeExe};
