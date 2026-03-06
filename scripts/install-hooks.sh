#!/usr/bin/env bash
# install-hooks.sh
#
# Installs a post-commit hook into cr-api and cr-data that runs check-stale.js
# in non-interactive mode after every commit.
#
# Run from cr-docs/:
#   bash scripts/install-hooks.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCS_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DOCS_ROOT}/.." && pwd)"

CHECK_STALE_SCRIPT="${DOCS_ROOT}/scripts/check-stale.js"

REPOS=("cr-api" "cr-data")

HOOK_CONTENT='#!/usr/bin/env bash
# CR Docs stale-check hook (installed by cr-docs/scripts/install-hooks.sh)
# Runs in non-interactive mode — writes stale-report.json if docs are stale.

CHECK_STALE="'"${CHECK_STALE_SCRIPT}"'"

if [ -f "${CHECK_STALE}" ]; then
  node "${CHECK_STALE}" --non-interactive
else
  echo "[cr-docs hook] check-stale.js not found at ${CHECK_STALE} — skipping."
fi
'

for REPO in "${REPOS[@]}"; do
  REPO_PATH="${REPO_ROOT}/${REPO}"
  HOOKS_DIR="${REPO_PATH}/.git/hooks"

  if [ ! -d "${REPO_PATH}" ]; then
    echo "WARN: ${REPO_PATH} not found — skipping ${REPO}."
    continue
  fi

  if [ ! -d "${HOOKS_DIR}" ]; then
    echo "WARN: ${HOOKS_DIR} not found — is ${REPO} a git repo?"
    continue
  fi

  HOOK_FILE="${HOOKS_DIR}/post-commit"

  if [ -f "${HOOK_FILE}" ]; then
    # Append to existing hook rather than overwrite
    if grep -q "check-stale.js" "${HOOK_FILE}"; then
      echo "INFO: ${REPO} post-commit hook already contains check-stale.js — skipping."
      continue
    fi
    echo "" >> "${HOOK_FILE}"
    echo "# CR Docs stale-check (appended by install-hooks.sh)" >> "${HOOK_FILE}"
    echo "node \"${CHECK_STALE_SCRIPT}\" --non-interactive" >> "${HOOK_FILE}"
    echo "OK: Appended stale-check to existing ${REPO} post-commit hook."
  else
    echo "${HOOK_CONTENT}" > "${HOOK_FILE}"
    chmod +x "${HOOK_FILE}"
    echo "OK: Installed post-commit hook in ${REPO}."
  fi
done

echo ""
echo "Done. After committing to cr-api or cr-data, check:"
echo "  cat cr-docs/scripts/stale-report.json"
echo "Then run: node cr-docs/scripts/check-stale.js"
echo "to handle stale docs interactively."
