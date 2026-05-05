import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.resolve(__dirname, '..', 'templates');

export async function renderTemplate(name, values) {
  const template = await readFile(path.join(templatesDir, name), 'utf8');

  return template
    .replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_match, key) => replaceValue(values, key))
    .replace(/@@([A-Za-z0-9_]+)@@/g, (_match, key) => replaceValue(values, key));
}

function replaceValue(values, key) {
  const value = values[key];
  return value == null ? '' : String(value);
}
