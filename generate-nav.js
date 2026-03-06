#!/usr/bin/env node
/**
 * generate-nav.js
 * Scans docs/ tree and writes nav.json.
 * Run: node generate-nav.js
 */

const fs = require('fs');
const path = require('path');

const DOCS_DIR = path.join(__dirname, 'docs');
const OUT_FILE = path.join(__dirname, 'nav.json');

function titleCase(str) {
  return str
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function stripLeadingNumber(name) {
  return name.replace(/^\d+-/, '');
}

function extractTitle(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/^#\s+(.+)/m);
    return match ? match[1].trim() : titleCase(stripLeadingNumber(path.basename(filePath, '.md')));
  } catch {
    return titleCase(stripLeadingNumber(path.basename(filePath, '.md')));
  }
}

function walk(dir, prefix = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  // Sort so numbered files come in order
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const results = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const children = walk(fullPath, relPath);
      results.push(...children);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const section = prefix
        ? titleCase(stripLeadingNumber(prefix.split('/').pop()))
        : 'Introduction';
      const navPath = relPath.replace(/\.md$/, '');
      const title = extractTitle(fullPath);
      results.push({ section, title, path: navPath });
    }
  }

  return results;
}

const nav = walk(DOCS_DIR);
fs.writeFileSync(OUT_FILE, JSON.stringify(nav, null, 2));
console.log(`nav.json written with ${nav.length} entries:`);
nav.forEach(e => console.log(`  [${e.section}] ${e.title} → ${e.path}`));
