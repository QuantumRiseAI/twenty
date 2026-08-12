#!/usr/bin/env bash
# Assert that this fork's patches are still present and still wired in.
#
# WHY THIS EXISTS. The failure mode worth defending against is not a merge
# conflict — conflicts are loud and someone resolves them. It is a *clean* merge
# that silently drops a patch because upstream refactored around it rather than
# into it. Nothing fails, CI is green, and the first symptom is production
# crash-looping on an auth path that no longer exists.
#
# The 2026-08-12 sync merged 126 upstream commits with zero conflicts. These
# checks were run by hand that day; this file exists so nobody has to remember
# to.
#
# Every check is deliberately shallow — presence and wiring, not behaviour. The
# tests cover behaviour. What this catches is a patch that has quietly ceased to
# exist or ceased to be referenced.
#
# Run from the repository root.
set -uo pipefail

cd "$(dirname "$0")/.."

SERVER=packages/twenty-server
STRATEGIES=$SERVER/src/engine/core-modules/auth/strategies
failures=0

# `label` describes what a human loses if the check fails, not what the check
# does — a failure here is read by whoever is midway through a sync and needs to
# know whether to care.
check () {
  local label=$1 hint=$2
  shift 2
  if "$@" >/dev/null 2>&1; then
    printf '  ok    %s\n' "$label"
  else
    printf '  FAIL  %s\n       %s\n' "$label" "$hint"
    failures=$((failures + 1))
  fi
}

not () { ! "$@" >/dev/null 2>&1; }

echo "Entra ID authentication for Postgres"
check "auth driver present" \
  "Postgres would fall back to password auth, which we do not have." \
  test -f "$SERVER/src/database/typeorm/database-auth.ts"
check "auth driver tests present" \
  "The driver is unprotected; its failure modes are subtle and were expensive to find." \
  test -f "$SERVER/src/database/typeorm/database-auth.spec.ts"
check "auth driver still referenced" \
  "The file survived but nothing calls it, so tokens are never requested." \
  grep -rq "buildDatabaseAuthExtra" "$SERVER/src"
check "@azure/identity declared" \
  "Token acquisition fails at runtime with a module-not-found." \
  grep -q "@azure/identity" "$SERVER/package.json"

echo "Microsoft sign-in tenant"
check "AUTH_MICROSOFT_TENANT_ID declared" \
  "The config key is gone, so the strategies below cannot read it." \
  grep -q "AUTH_MICROSOFT_TENANT_ID" \
  "$SERVER/src/engine/core-modules/twenty-config/config-variables.ts"
check "sign-in strategy reads it" \
  "Sign-in reverts to the /common endpoint and every attempt fails AADSTS50194." \
  grep -q "AUTH_MICROSOFT_TENANT_ID" "$STRATEGIES/microsoft.auth.strategy.ts"
check "APIs strategy reads it" \
  "Calendar and messaging OAuth reverts to /common and cannot connect." \
  grep -q "AUTH_MICROSOFT_TENANT_ID" "$STRATEGIES/microsoft-apis-oauth-common.auth.strategy.ts"
# The inverse of the two above: an upstream file that reintroduces the hard-coded
# endpoint passes every presence check while still breaking sign-in.
check "no hard-coded 'common' endpoint" \
  "Some strategy went back to tenant: 'common'; find it with: grep -rn \"tenant: 'common'\" $SERVER/src" \
  not grep -rq "tenant: 'common'" "$SERVER/src"

echo "Release tooling"
check "publish workflow present" \
  "Nothing builds or pushes an image to our registry." \
  test -f .github/workflows/qr-publish-image.yaml

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures fork patch check(s) failed."
  echo
  echo "This usually means an upstream merge removed or refactored past one of"
  echo "our patches. Do not merge until it is restored: the patches are what"
  echo "make this fork deployable, and every one of them fails at runtime rather"
  echo "than at build time."
  exit 1
fi

echo "All fork patches present and wired in."
