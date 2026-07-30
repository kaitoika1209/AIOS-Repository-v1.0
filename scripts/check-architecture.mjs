import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const modulesRoot = join(root, 'apps', 'api', 'src', 'modules');
const sourceExtensions = new Set(['.ts', '.tsx']);
const violations = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (sourceExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

for (const file of await walk(modulesRoot)) {
  const local = relative(modulesRoot, file).split(sep);
  const owner = local[0];
  const layer = local[1];
  const text = await readFile(file, 'utf8');
  const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);

  if (layer === 'domain' && imports.some((value) => value.startsWith('@nestjs/') || value.includes('prisma') || value.includes('/infrastructure'))) {
    violations.push(`${relative(root, file)}: Domain depends on framework or infrastructure`);
  }

  for (const imported of imports) {
    const match = imported.match(/modules\/([^/]+)\/(domain|infrastructure)/);
    if (match && match[1] !== owner) violations.push(`${relative(root, file)}: imports another module's ${match[2]}`);
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Architecture boundaries verified.');
}
