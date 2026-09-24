# Quantum Rise Fork

Everything in this directory is fork-only.
Upstream has nothing here, so it never conflicts on a rebase.

The fork tracks upstream *releases*, not upstream `main`.
A release tag is a point upstream has run its own full CI against, which is most of the confidence this fork gets for free.

## What The Fork Carries

Four changes, all in `twenty-server`.
Each is inert by default, so an unconfigured deployment behaves exactly like upstream.

* Entra ID authentication for Postgres (`PG_DATABASE_AUTH_MODE`)
  - Azure Database for PostgreSQL can have password auth disabled, leaving a short-lived Entra token as the only way in.
  - `pg` accepts a function for `password` and calls it per new connection, so a long-lived pool survives token expiry.
  - Applies at every data source that opens a pool. See [Call Sites Are The Fragile Part](#call-sites-are-the-fragile-part).
* Configurable Microsoft auth tenant (`AUTH_MICROSOFT_TENANT_ID`, default `common`)
  - Upstream pins `common`, which a single-tenant app registration created after 2018-10-15 cannot use at all (`AADSTS50194`).
  - Set to a directory ID to restrict sign-in to one organisation.
  - Three call sites: both passport strategies and the MSAL authority used by every token refresh.
* Configurable BullMQ queue retention (`QUEUE_COMPLETED_MAX_*`, `QUEUE_FAILED_MAX_*`)
  - Retention was hardcoded, and it is what decides how much of Redis the queue occupies.
  - A bulk import once filled a 0.5 GB Redis to 100%; being `NoEviction`, it stopped accepting writes rather than shedding keys.
* `QR / Publish image` workflow (`.github/workflows/qr-publish-image.yaml`)
  - Builds `twenty-server` and pushes it to the production ACR.
  - Vendors `@azure/identity` at build time, because it is an optional peer dependency that `yarn workspaces focus` skips.

## Syncing With A New Upstream Release

```sh
qr/sync-upstream.sh --list     # what is available, and where we are
qr/sync-upstream.sh            # rebase onto the newest release
```

The script adds the `upstream` remote if missing, fetches, creates `qr-sync-upstream-<version>`, and replays the patches.
It stops at the first conflict and leaves the rebase in progress.
It never pushes and never touches `main`.

Then, in order:

1. `qr/verify-patches.sh` — patches still reach their call sites.
2. `yarn nx build twenty-shared` — nothing downstream typechecks honestly until this is current.
3. `cd packages/twenty-server && npx tsgo -p tsconfig.json --noEmit`
4. `yarn nx lint twenty-server`
5. `npx jest --config=packages/twenty-server/jest.config.mjs`
6. `yarn nx build twenty-server` — catches anything the lazy `@azure/identity` import breaks.

Open a PR against `main` from the sync branch.
There is no CI on it — upstream's workflows stay disabled here and `QR / Publish image` only triggers on push to `main` — so the checks above are the only verification the change gets.

GitHub will report the PR as conflicting, and the merge button is the wrong tool.
That is inherent to a rebase: the branch shares no mergeable history with the current `main`, and "Rebase and merge" would replay the patches onto the old base again.
The PR is for review. Landing is moving `main` onto the reviewed branch:

```sh
git push --force-with-lease=main:<reviewed main sha> origin qr-sync-upstream-<version>:main
```

Pin `--force-with-lease` to the SHA the PR was reviewed against, so the push refuses if `main` moved.
Use a full refspec: `push.default` is `upstream` in this org's checkouts, and a bare `git push origin <branch>` can land somewhere you did not mean.

### Call Sites Are The Fragile Part

A rebase fails loudly when a patched *line* moved and quietly when a patched *call site* moved.
Git resolves a patch against the file it was written for.
It has nothing to say about a fourth place upstream started opening database connections, or a strategy that went back to hardcoding a tenant.
Both leave a clean tree, a green build, and a broken deployment.

This is not hypothetical.
Upstream v2.40.0 deleted `GlobalWorkspaceDataSourceService`, one of the three data sources the Entra patch hooks, and moved the workspace pool into `WorkspaceDataSourceService`.
The rebase reported one conflict, on a file being deleted.
Had that been resolved by simply accepting the deletion, every workspace query would have fallen back to password auth against a server that refuses passwords.

`qr/verify-patches.sh` exists for exactly this.
It checks reach rather than content, and it fails when the set of files calling into a patch changes in either direction.
A new upstream data source shows up as a failure, which is the point.

Run it after every rebase, before the image build.

## Deploying

Every step below, in order.
Skipping one fails quietly, not loudly: the app keeps serving while its data or metadata drifts.
Infrastructure lives in [`QuantumRiseAI/infra`](https://github.com/QuantumRiseAI/infra), under `environments/production/twenty.tf`.

### 1. Pre-Flight

Before building, check the versions being crossed.

* `TWENTY_PREVIOUS_VERSIONS` must list the version being upgraded *from*.
  The upgrade runs every intermediate step in order, but only from a version it knows.
* Grep the crossed versions for new Postgres extensions (see [Postgres Extensions Are A Recurring Trap](#postgres-extensions-are-a-recurring-trap)).
* Grep the crossed versions' *instance* commands for forward `DROP COLUMN` or `RENAME COLUMN`.
  Harmless in a normal upgrade, but they are what make a later replay of skipped steps hard (see [Recovering Skipped Steps](#recovering-skipped-steps)).

```sh
git grep -nE "async up" -A12 twenty/v<version> -- 'packages/twenty-server/src/database/commands/upgrade-version-command/*/*instance*' \
  | grep -E "DROP COLUMN|RENAME COLUMN"
```

### 2. Build The Image

Merging to `main` triggers `QR / Publish image`, which pushes to the production ACR and prints the digest in its job summary.
The build asserts that `@azure/identity` resolves inside the image, so a silent regression in the vendoring step is a red build rather than a runtime failure on the first token acquisition.

### 3. Take A Dump

Take a fresh `pg_dump` of the `twenty` database before anything touches it.
It is the only rollback that is quick, scoped to this database, and exactly as of the upgrade.
The server's point-in-time restore also covers the moment, but restoring it builds a new *server*.
See [Taking An Ad-Hoc Dump](#taking-an-ad-hoc-dump).

### 4. Pin The Digest

Update `twenty_image` in `environments/production/twenty.tf` to the new digest and apply.
The repo pins by digest, never by tag.

### 5. Run The Migration Job

```sh
az containerapp job start -n twenty-migrate -g qr-twenty-rg
```

Run this after every image bump, before the new revision serves traffic.
The image's entrypoint cannot do this work here: it shells out to `psql`, which knows nothing about the Entra-token patch and dies on a passwordless URL.

The Job does four things:

* `database:init:prod`, only when the database is empty (no `core` schema), exactly as the upstream entrypoint gates it.
* `command:prod upgrade`, the whole sequence in version order, *instance* and *workspace* steps interleaved.
* `cache:flush --namespace engine:workspace`, the workspace metadata cache.
  Never the unscoped flush, which also clears `engine:auth-session` and signs everyone out.
* `cron:register:all`.

Never run `database:init:prod` ahead of `upgrade` on an existing database.
It ends in `run-instance-commands --force`, which executes and records every *instance* step up to the newest version.
`upgrade` then resumes after the newest recorded step, not from each workspace's own position,
so every *workspace* step that sits between instance steps is skipped.
Nothing fails, and `upgrade:status` still reports the workspace as up to date.

That is what the Job did until infra#1074, and it cost two upgrades:

* On 2026-08-12, the 2.31 and 2.32 workspace steps were skipped.
* On 2026-09-14, the 2.32 to 2.40 jump skipped about fifty more.
* One of them was the 2.38 company-domain normalization.
  Contact auto-creation matches companies on the bare domain, so email and calendar sync created duplicates of existing companies.

### 6. Restart Both Apps

Restart `twenty` and `twenty-worker` after the Job, even though the image bump already rolled them:

```sh
for app in twenty twenty-worker; do
  az containerapp revision restart -n "$app" -g qr-twenty-rg \
    --revision "$(az containerapp revision list -n "$app" -g qr-twenty-rg --query '[?properties.active].name | [0]' -o tsv)"
done
```

An upgrade that reshapes workspace metadata leaves every running process holding the old shape in memory.
Record queries then fail with `Didn't expect to get here.` until the process restarts.
The Job's flush clears the shared Redis copy; it cannot reach a running process, so both are needed.
Expect record queries to fail for users between the upgrade and the restart.

The restart is rolling, so an old replica can keep serving for a minute; wait until only new replicas are listed:

```sh
az containerapp replica list -n twenty -g qr-twenty-rg --query "[].{name:name,created:properties.createdTime}" -o table
```

### 7. Verify

* `upgrade:status` reports both instance and workspace up to date.
  It only proves the *newest* step ran, which is exactly what it said on 2026-09-14 with fifty steps missing.
* The upgrade's own log has no `Error in workspace`.
  A workspace command that fails still exits 0, so the exit code proves nothing.
* The app logs since the restart show no `ERROR`, and a record query through the API returns data.

## Running One-Off Commands In Production

Start `twenty-migrate` from its own template with only the command replaced.
Overriding with `--command`/`--args` drops the Job's environment, and the run dies connecting to `127.0.0.1:5432`:

```sh
az containerapp job show -n twenty-migrate -g qr-twenty-rg --query properties.template -o json > template.json
jq '{containers: [.containers[0] | .command = ["/bin/sh"] | .args = ["-c", "yarn command:prod upgrade:status"]]}' \
  template.json > run.yaml
az containerapp job start -n twenty-migrate -g qr-twenty-rg --yaml run.yaml
```

* The template holds secret *references*, not values, so writing it to disk exposes nothing.
* Read the output in Log Analytics, table `ContainerAppConsoleLogs_CL`, filtered on `ContainerGroupName_s startswith '<execution name>'`.
  Allow about 90 seconds for ingestion.
* The Job retries a failed run once (`replica_retry_limit = 1`), so a script that must not run twice should end in `exit 0` and report its result instead.
* `psql` works inside the Job with an Entra token as `PGPASSWORD`, fetched from the identity endpoint for resource `https://ossrdbms-aad.database.windows.net`.
  `twenty-mi` owns the `core` tables.

Starting a Job can override its command and image, so anyone who can start `twenty-migrate` can run arbitrary code as Twenty's identity.
Treat the start permission accordingly (INFRA-105).

## Recovering Skipped Steps

Re-running the Job does not recover a skipped step.
Its start cursor is already past the step, so the step never runs again on its own.

Do **not** run the skipped steps by name (`yarn command:prod upgrade:2-33:...`).
Inside `upgrade`, a compatibility layer presents the schema as it was at each step's version.
A command run by name skips that layer and sees today's schema and today's standard definitions.
Self-contained steps survive it; steps that depend on earlier ones fail, or worse, apply against the wrong shape.
On 2026-09-24 the 2.33 timeline step failed validation run that way, even though it passed inside the sequence.
Commands run by name are also not recorded in `core."upgradeMigration"`.

Make `upgrade` itself replay the skipped segment instead, and rehearse it on a restored dump first.
The procedure that worked on 2026-09-24:

1. **Find the gap.** Compare the workspace's rows in `core."upgradeMigration"` (`workspaceId` set, names without `InstanceCommand`) against the registered workspace commands per version.
   The workspace's `isInitial` row is where it started.
2. **Move the cursors.** Both are "the newest row by `createdAt`".
   Set `createdAt = now()` on the *global* row (`workspaceId` null) of the last instance step before the first skipped segment.
   Then set `createdAt = now()` on the workspace's row for the last step it genuinely completed, usually its `isInitial` row.
   Record the original values first.
3. **Put back what later instance steps dropped.** Instance steps already ran to the newest version, so a column a *later* version dropped is gone while the replayed steps still write it.
   Re-add each such column exactly as it was created (2026-09-24 needed `core."timelineActivityType"."renderer" character varying`).
   The pre-flight grep finds the candidates.
4. **Run `yarn command:prod upgrade`.**
   Completed instance steps are skipped from their global rows; workspace segments run in order with the right schema shape.
5. **Undo the scaffolding.** Drop the re-added columns, and restore both original `createdAt` values.
   Otherwise `upgrade:status` reports the instance as behind.
6. **Flush `engine:workspace`, then restart both apps**, as in steps 6 and 7 above.

For the rehearsal, restore the dump into a local Postgres of the server's major version.
Build `twenty-server` from the image's commit (the image tag is `sha-<commit>`).
Run steps 2 to 5 against the restored copy, then boot the server and query records through the API.
Compare record counts against a second, untouched restore of the same dump.
Reset `core."signingKey"` in the copy to get a local API key; its keys are encrypted with production's secret.

## Upgrade Traps

### Postgres Extensions Are A Recurring Trap

An upgrade command can require a Postgres extension the server does not allow.
Azure refuses any `CREATE EXTENSION` for an extension missing from the server-level `azure.extensions` allow-list, even one PostgreSQL ships in core and marks trusted.
The upgrade then fails partway, with the app already serving new code.

This is what 2.40.0 did: 2.37.0 added a command making user email case-insensitive, which needs `citext`, and the allow-list did not have it.

Nothing in the fork asks for these, so reviewing our own patches will never surface one.
Grep the versions being crossed before deploying:

```sh
git grep -iE "CREATE EXTENSION" twenty/v<version> -- packages/twenty-server/src/database/commands
```

Anything new goes in `extensions` in `environments/production/postgres.tf` in the infra repo.
`azure.extensions` is a dynamic parameter, so adding to it needs no restart and does not disturb the other apps on the shared server.

## Backups

The CRM database is `twenty` on the shared `qr-production-pg` server.
Backups are enrolled at the *server* level, so it is covered by the same immutable vaulted backup as every other database there.
See `environments/production/backup.tf` in the infra repo.

Do not infer per-database coverage from ownership metadata: Azure's support matrix and its actual behaviour disagree, and the infra repo documents why.
A restore drill's file listing is the only trustworthy answer.

### Taking An Ad-Hoc Dump

There is no paved way to take a dump yet (INFRA-211).
The way that worked on 2026-09-24 was a one-off command in `twenty-migrate` (see [Running One-Off Commands In Production](#running-one-off-commands-in-production)).
It runs as `twenty-mi`, which owns the database, so it needs no extra database access:

```sh
token_for() {
  curl -sf -H "X-IDENTITY-HEADER: $IDENTITY_HEADER" \
    "$IDENTITY_ENDPOINT?api-version=2019-08-01&resource=$1&client_id=$PG_DATABASE_AZURE_CLIENT_ID" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).access_token))'
}
PGPASSWORD=$(token_for https://ossrdbms-aad.database.windows.net) PGSSLMODE=require \
  pg_dump -Fc -h qr-production-pg.postgres.database.azure.com -U twenty-mi -d twenty -f /tmp/twenty.dump
curl -sf -X PUT -H "Authorization: Bearer $(token_for https://storage.azure.com/)" \
  -H "x-ms-version: 2021-08-06" -H "x-ms-blob-type: BlockBlob" \
  --data-binary @/tmp/twenty.dump "https://<account>.blob.core.windows.net/<container>/twenty-<stamp>.dump"
```

* Print the dump's size and `sha256sum` in the run, and compare them with the stored blob.
* The image's `pg_dump` must match the server's major version (both are 18).
* The upload needs a container `twenty-mi` can write to, granted temporarily and removed afterwards.
  The restore-staging account denies all networks except the backup vault, by design, so it cannot be used.
  On 2026-09-24 a temporary account (`qrtwentydump0924`, shared keys off, 7-day lifecycle delete, blob reads logged) was made by hand; delete such an account when it is no longer needed.

To roll back to a dump, restore it over the database from the same Job, then flush and restart as after an upgrade.
Download the blob into the Job first with the same storage token (`curl -sf -H "Authorization: Bearer …" -H "x-ms-version: 2021-08-06" -o twenty.dump <blob URL>`), which needs read access on the container:

```sh
pg_restore --clean --if-exists --no-owner -h qr-production-pg.postgres.database.azure.com -U twenty-mi -d twenty twenty.dump
```

Everything written after the dump was taken is lost, so a rollback is a decision, not a reflex.
