#!/usr/bin/env bash
#
# Asserts that every fork patch is still fully applied.
#
# A rebase onto a new upstream release fails loudly when a patched line moved
# and quietly when a patched *call site* moved. Git resolves a patch against the
# file it was written for; it has nothing to say about a fourth place upstream
# started opening database connections, or a second strategy that went back to
# hardcoding a tenant. Both leave a clean tree and a green build, and both are
# real: v2.40.0 deleted the data source the Entra patch hooked and moved the
# workspace pool somewhere else entirely.
#
# So this checks reach rather than content. Run it after every upstream rebase,
# before the image build.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SRC=packages/twenty-server/src
failures=0

fail() {
  printf '  \033[31mFAIL\033[0m  %s\n' "$1"
  failures=$((failures + 1))
}

pass() {
  printf '  \033[32mok\033[0m    %s\n' "$1"
}

# Non-spec TypeScript sources only: test doubles legitimately contain the
# literals this asserts the absence of.
src_files() {
  grep -rl --include='*.ts' "$1" "$SRC" 2>/dev/null \
    | grep -v '\.spec\.ts$' \
    | grep -v '/__tests__/' \
    | sort
}

echo
echo "Microsoft tenant (AUTH_MICROSOFT_TENANT_ID)"

if grep -q "AUTH_MICROSOFT_TENANT_ID = 'common'" \
  "$SRC/engine/core-modules/twenty-config/config-variables.ts"; then
  pass "declared, still defaulting to 'common'"
else
  fail "AUTH_MICROSOFT_TENANT_ID is not declared with its 'common' default"
fi

# The whole point of the patch: no code path may pin the tenant itself.
if hardcoded=$(src_files "tenant: 'common'"); [ -n "$hardcoded" ]; then
  fail "a strategy hardcodes tenant: 'common' again:"
  printf '          %s\n' $hardcoded
else
  pass "no strategy hardcodes tenant: 'common'"
fi

if hardcoded=$(src_files "login\.microsoftonline\.com/common"); [ -n "$hardcoded" ]; then
  fail "an MSAL authority hardcodes /common again:"
  printf '          %s\n' $hardcoded
else
  pass "no MSAL authority hardcodes /common"
fi

# Two passport strategies plus the MSAL authority used by every token refresh.
# The refresh path is the one that went missing the first time: the strategies
# run once at connect, the refresh runs forever after.
tenant_consumers=$(grep -rl --include='*.ts' "AUTH_MICROSOFT_TENANT_ID" "$SRC" \
  | grep -v '\.spec\.ts$' | grep -v '/__tests__/' \
  | grep -v 'twenty-config/config-variables.ts' | sort)
expected_tenant_consumers="$SRC/engine/core-modules/auth/strategies/microsoft-apis-oauth-common.auth.strategy.ts
$SRC/engine/core-modules/auth/strategies/microsoft.auth.strategy.ts
$SRC/modules/connected-account/refresh-tokens-manager/drivers/microsoft/services/microsoft-api-refresh-tokens.service.ts"

if [ "$tenant_consumers" = "$(echo "$expected_tenant_consumers" | sort)" ]; then
  pass "both strategies and the token-refresh authority read the setting"
else
  fail "the set of files reading AUTH_MICROSOFT_TENANT_ID changed:"
  diff <(echo "$expected_tenant_consumers" | sort) <(echo "$tenant_consumers") \
    | sed 's/^/          /'
fi

echo
echo "Entra ID Postgres auth (buildDatabaseAuthExtra)"

# Every site that opens a Postgres connection has to route through the helper,
# or that pool authenticates with a password against a server that has password
# auth disabled. Upstream adding a new data source is the failure this catches.
expected_auth_sites="$SRC/database/typeorm/core/core.datasource.ts
$SRC/database/typeorm/raw/raw.datasource.ts
$SRC/engine/twenty-orm/datasource/workspace-data-source.service.ts"

auth_sites=$(src_files "buildDatabaseAuthExtra" | grep -v 'database-auth\.ts$')

if [ "$auth_sites" = "$(echo "$expected_auth_sites" | sort)" ]; then
  pass "all three pool-opening data sources call the helper"
else
  fail "the set of files calling buildDatabaseAuthExtra changed:"
  diff <(echo "$expected_auth_sites" | sort) <(echo "$auth_sites") \
    | sed 's/^/          /'
fi

# typeorm.module.ts builds its DataSource from typeORMCoreModuleOptions, so it
# inherits core.datasource's auth rather than calling the helper itself.
expected_pool_sites="$SRC/database/typeorm/core/core.datasource.ts
$SRC/database/typeorm/raw/raw.datasource.ts
$SRC/database/typeorm/typeorm.module.ts
$SRC/engine/twenty-orm/datasource/workspace-data-source.service.ts"

pool_sites=$(src_files "new Pool(\|new DataSource(")

if [ "$pool_sites" = "$(echo "$expected_pool_sites" | sort)" ]; then
  pass "no new connection-opening site appeared upstream"
else
  fail "upstream changed where Postgres connections are opened — every new site needs the helper:"
  diff <(echo "$expected_pool_sites" | sort) <(echo "$pool_sites") \
    | sed 's/^/          /'
fi

echo
echo "Queue retention (QUEUE_COMPLETED_MAX_* / QUEUE_FAILED_MAX_*)"

# The constants survive only as the defaults the config variables fall back to.
# Anything else reading them is a queue that ignores the configured retention.
retention_readers=$(grep -rl --include='*.ts' "QUEUE_RETENTION" "$SRC" \
  | grep -v '\.spec\.ts$' | grep -v '/__tests__/' \
  | grep -v 'constants/queue-retention.constants.ts' | sort)
expected_retention_readers="$SRC/engine/core-modules/twenty-config/config-variables.ts"

if [ "$retention_readers" = "$expected_retention_readers" ]; then
  pass "QUEUE_RETENTION is read only as the config defaults"
else
  fail "something reads QUEUE_RETENTION directly again:"
  diff <(echo "$expected_retention_readers") <(echo "$retention_readers") \
    | sed 's/^/          /'
fi

driver="$SRC/engine/core-modules/message-queue/drivers/bullmq.driver.ts"
retention_spreads=$(grep -c '\.\.\.this\.retentionOptions()' "$driver")

# One for the repeatable-job path (addCron), one for the regular enqueue path
# (buildJobsOptions, shared by add and bulkAdd). A new enqueue path upstream
# means a third.
if [ "$retention_spreads" -ge 2 ]; then
  pass "both enqueue paths apply the configured retention ($retention_spreads sites)"
else
  fail "only $retention_spreads enqueue path(s) apply retention — expected at least 2"
fi

if grep -q 'removeOnComplete: {\s*$' "$driver" && grep -q 'QUEUE_RETENTION' "$driver"; then
  fail "the driver builds retention from the constants again"
else
  pass "the driver builds retention only from config"
fi

echo
if [ "$failures" -eq 0 ]; then
  printf '\033[32mAll fork patches are fully applied.\033[0m\n\n'
  exit 0
fi

printf '\033[31m%d check(s) failed — a patch lost its reach.\033[0m\n' "$failures"
echo "Fix before building an image: a failure here is silent at runtime."
echo
exit 1
