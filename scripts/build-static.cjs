'use strict';

const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const output = path.join(project, 'dist');
const assets = [
  'index.html',
  'styles.css',
  'call.css',
  'features.css',
  'design.css',
  'app.js',
  'auth.js',
  'supabase.js',
  'runtime-config.js',
  'site-config.js'
];

if (path.dirname(output) !== project || path.basename(output) !== 'dist') {
  throw new Error(`Refusing to replace unexpected output directory: ${output}`);
}

for (const asset of assets) {
  const source = path.join(project, asset);
  if (!fs.existsSync(source)) throw new Error(`Missing browser asset: ${asset}`);
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const asset of assets) fs.copyFileSync(path.join(project, asset), path.join(output, asset));

const browserReferences = [...fs.readFileSync(path.join(project, 'index.html'), 'utf8').matchAll(/(?:href|src)="([^"#]+)"/g)]
  .map(match => match[1])
  .filter(reference => !/^https?:\/\//i.test(reference));
for (const reference of browserReferences) {
  if (!fs.existsSync(path.join(output, reference))) throw new Error(`index.html references an unpublished asset: ${reference}`);
}

process.stdout.write(`Prepared ${assets.length} public browser assets in ${output}\n`);
