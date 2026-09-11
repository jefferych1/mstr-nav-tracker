#!/usr/bin/env bash
# One-shot setup using the GitHub CLI. Install it first (macOS: brew install gh),
# then run:   gh auth login   and:   ./setup.sh [repo-name] [public|private]
#
# Defaults to a PUBLIC repo: GitHub Pages only serves from a private repo on a paid plan,
# and everything here is public information anyway (SEC filings and market prices).
#
# If you would rather not use the CLI, everything this does can be done in the browser —
# see the Setup section of README.md.
set -euo pipefail

REPO="${1:-mstr-nav-tracker}"
VISIBILITY="${2:-public}"

command -v gh >/dev/null || { echo "gh not found. brew install gh   (or follow README.md)"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Not signed in. Run: gh auth login"; exit 1; }

USER_LOGIN=$(gh api user --jq .login)
EMAIL=$(git config user.email || echo "you@example.com")

echo "==> Creating ${VISIBILITY} repository ${USER_LOGIN}/${REPO}"
git init -q 2>/dev/null || true
git add -A
git -c user.name="${USER_LOGIN}" -c user.email="${EMAIL}" \
    commit -qm "MSTR NAV tracker: static site with automated daily refresh" || true
git branch -M main
gh repo create "${REPO}" "--${VISIBILITY}" --source=. --remote=origin --push

echo "==> Allowing Actions to commit the data they fetch"
gh api -X PUT "repos/${USER_LOGIN}/${REPO}/actions/permissions/workflow" \
  -f default_workflow_permissions=write -F can_approve_pull_request_reviews=false

echo "==> Setting the SEC contact header"
gh variable set SEC_USER_AGENT --body "${USER_LOGIN} mstr-nav-tracker ${EMAIL}" --repo "${USER_LOGIN}/${REPO}"

echo "==> Turning on GitHub Pages"
gh api -X POST "repos/${USER_LOGIN}/${REPO}/pages" \
  -f "source[branch]=main" -f "source[path]=/" 2>/dev/null \
  || echo "    (Pages may already be on — check Settings → Pages)"

echo "==> Kicking off the first runs"
sleep 5
gh workflow run "Daily prices"    --repo "${USER_LOGIN}/${REPO}" || true
gh workflow run "Filings refresh" --repo "${USER_LOGIN}/${REPO}" || true

cat <<EOF

Done.

  Site      https://${USER_LOGIN}.github.io/${REPO}/
  Actions   https://github.com/${USER_LOGIN}/${REPO}/actions

Pages can take a couple of minutes to publish the first time. Check that both workflow
runs are green; after that it looks after itself.

This created a ${VISIBILITY} repository. Pages only serves from a private repository on a
paid plan, so if you passed "private" on a free plan the site will not appear until you
make it public (Settings -> General -> Change visibility). Nothing in here is secret.
EOF
