#!/usr/bin/env node
/**
 * check-stale.js
 *
 * Detects when source files in cr-api/cr-data have changed since the last doc check
 * and interactively prompts: update docs now, open a GH issue, or skip.
 *
 * Usage:
 *   node scripts/check-stale.js                   # interactive mode
 *   node scripts/check-stale.js --non-interactive  # write stale-report.json and exit
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const SCRIPT_DIR = __dirname;
const DOCS_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(DOCS_ROOT, '..');
const LAST_CHECK_FILE = path.join(SCRIPT_DIR, '.last-check');
const DOC_SOURCES_FILE = path.join(DOCS_ROOT, 'doc-sources.json');
const STALE_REPORT_FILE = path.join(SCRIPT_DIR, 'stale-report.json');

const REPO_PATHS = {
  'cr-api': path.join(REPO_ROOT, 'cr-api'),
  'cr-data': path.join(REPO_ROOT, 'cr-data'),
};

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const NON_INTERACTIVE = process.argv.includes('--non-interactive');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readLastCheckTimestamp() {
  if (fs.existsSync(LAST_CHECK_FILE)) {
    const raw = fs.readFileSync(LAST_CHECK_FILE, 'utf8').trim();
    const ts = new Date(raw);
    if (!isNaN(ts.getTime())) return ts.toISOString();
  }
  // Default: 7 days ago
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
}

function writeLastCheckTimestamp() {
  fs.writeFileSync(LAST_CHECK_FILE, new Date().toISOString(), 'utf8');
}

/**
 * Expand a glob-like pattern into a list of matching files using git ls-files.
 * We pass patterns directly to `git log -- <pattern>` which supports shell globs
 * interpreted by git (pathspecs). No shell is involved.
 */
function getChangedFilesForGlob(repoPath, glob, since) {
  if (!fs.existsSync(repoPath)) return { files: [], commits: [] };

  let logOutput = '';
  try {
    logOutput = execFileSync(
      'git',
      ['log', `--since=${since}`, '--name-only', '--format=%H %s', '--', glob],
      { cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch (_) {
    return { files: [], commits: [] };
  }

  const lines = logOutput.split('\n').filter(Boolean);
  const files = new Set();
  const commits = [];
  let currentCommit = null;

  for (const line of lines) {
    // Commit lines look like: "<40-char hash> <message>"
    if (/^[0-9a-f]{40}\s/.test(line)) {
      currentCommit = line;
      commits.push(line);
    } else if (currentCommit) {
      files.add(line.trim());
    }
  }

  return { files: Array.from(files), commits };
}

function checkDocEntry(docKey, entry, since) {
  const allChangedFiles = [];
  const allCommits = [];

  for (const [repoName, globs] of Object.entries(entry.repos)) {
    const repoPath = REPO_PATHS[repoName];
    if (!repoPath || !globs || globs.length === 0) continue;

    for (const glob of globs) {
      const { files, commits } = getChangedFilesForGlob(repoPath, glob, since);
      allChangedFiles.push(...files);
      allCommits.push(...commits);
    }
  }

  // Deduplicate
  const uniqueFiles = Array.from(new Set(allChangedFiles));
  const uniqueCommits = Array.from(new Set(allCommits));

  if (uniqueFiles.length === 0) return null;

  return {
    docKey,
    docPath: entry.docPath,
    description: entry.description,
    changedFiles: uniqueFiles,
    commits: uniqueCommits,
  };
}

// ---------------------------------------------------------------------------
// Interactive prompts
// ---------------------------------------------------------------------------

async function promptForDoc(rl, staleDoc) {
  const { docKey, docPath, changedFiles, commits } = staleDoc;

  console.log('\n' + '─'.repeat(70));
  console.log(`STALE: ${docKey}`);
  console.log(`  Doc file: ${docPath}`);
  console.log(`  Changed source files (${changedFiles.length}):`);
  for (const f of changedFiles.slice(0, 10)) {
    console.log(`    • ${f}`);
  }
  if (changedFiles.length > 10) {
    console.log(`    … and ${changedFiles.length - 10} more`);
  }
  console.log(`  Recent commits (${commits.length}):`);
  for (const c of commits.slice(0, 5)) {
    console.log(`    • ${c}`);
  }
  console.log();
  console.log('  [u] Update docs now  (calls claude CLI)');
  console.log('  [g] Open GitHub issue');
  console.log('  [s] Skip');

  return new Promise((resolve) => {
    rl.question('  Choice [u/g/s]: ', (answer) => {
      resolve(answer.trim().toLowerCase());
    });
  });
}

function runUpdateDocs(docPath) {
  const absDocPath = path.join(DOCS_ROOT, docPath);
  const prompt = `The following doc file may be out of date: ${absDocPath}
Please read the doc and the relevant source files, then update the doc to reflect any changes.`;

  console.log(`  → Invoking claude to update ${docPath} ...`);
  try {
    execFileSync('claude', ['--print', prompt], {
      stdio: 'inherit',
      cwd: DOCS_ROOT,
    });
    console.log('  ✓ Done.');
  } catch (err) {
    console.error(`  ✗ claude CLI failed: ${err.message}`);
    console.error('    Make sure the claude CLI is installed and in your PATH.');
  }
}

function openGithubIssue(staleDoc) {
  const { docKey, docPath, changedFiles, commits } = staleDoc;
  const title = `Docs stale: ${docKey}`;
  const body = [
    `The documentation page \`${docPath}\` may be out of date.`,
    '',
    '**Changed source files:**',
    changedFiles.map((f) => `- ${f}`).join('\n'),
    '',
    '**Recent commits:**',
    commits.slice(0, 10).map((c) => `- ${c}`).join('\n'),
    '',
    '_Generated by check-stale.js_',
  ].join('\n');

  console.log(`  → Opening GitHub issue for ${docKey} ...`);
  try {
    const result = execFileSync(
      'gh',
      ['issue', 'create', '--title', title, '--body', body, '--repo', 'CrystallineRift/cr-docs'],
      { encoding: 'utf8', cwd: DOCS_ROOT }
    );
    console.log(`  ✓ Issue created: ${result.trim()}`);
  } catch (err) {
    console.error(`  ✗ gh CLI failed: ${err.message}`);
    console.error('    Make sure gh is installed, authenticated, and the repo is correct.');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Load doc-sources.json
  if (!fs.existsSync(DOC_SOURCES_FILE)) {
    console.error(`ERROR: ${DOC_SOURCES_FILE} not found.`);
    process.exit(1);
  }
  const docSources = JSON.parse(fs.readFileSync(DOC_SOURCES_FILE, 'utf8'));

  const since = readLastCheckTimestamp();
  console.log(`Checking for source changes since: ${since}`);

  // Check each doc
  const staleDocs = [];
  for (const [docKey, entry] of Object.entries(docSources)) {
    const result = checkDocEntry(docKey, entry, since);
    if (result) staleDocs.push(result);
  }

  // Write timestamp now (before interactive prompts so re-runs don't re-check)
  writeLastCheckTimestamp();

  if (staleDocs.length === 0) {
    console.log('\n✓ All docs up to date.');
    return;
  }

  console.log(`\nFound ${staleDocs.length} stale doc(s).`);

  // Non-interactive mode: write report and exit
  if (NON_INTERACTIVE) {
    fs.writeFileSync(STALE_REPORT_FILE, JSON.stringify(staleDocs, null, 2), 'utf8');
    console.log(`Report written to: ${STALE_REPORT_FILE}`);
    console.log('Run without --non-interactive to handle interactively.');
    return;
  }

  // Interactive mode
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  for (const staleDoc of staleDocs) {
    const choice = await promptForDoc(rl, staleDoc);

    if (choice === 'u') {
      runUpdateDocs(staleDoc.docPath);
    } else if (choice === 'g') {
      openGithubIssue(staleDoc);
    } else {
      console.log('  → Skipped.');
    }
  }

  rl.close();
  console.log('\n✓ Done.\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
