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

Three steps, in order.
Infrastructure lives in [`QuantumRiseAI/infra`](https://github.com/QuantumRiseAI/infra), under `environments/production/twenty.tf`.

### 1. Build The Image

Merging to `main` triggers `QR / Publish image`, which pushes to the production ACR and prints the digest in its job summary.
The build asserts that `@azure/identity` resolves inside the image, so a silent regression in the vendoring step is a red build rather than a runtime failure on the first token acquisition.

### 2. Pin The Digest

Update `twenty_image` in `environments/production/twenty.tf` to the new digest and apply.
The repo pins by digest, never by tag.

### 3. Run The Migration Job

```sh
az containerapp job start -n twenty-migrate -g qr-twenty-rg
```

Run this after every image bump, before the new revision serves traffic.
The image's entrypoint cannot do this work here: it shells out to `psql`, which knows nothing about the Entra-token patch and dies on a passwordless URL.

On an existing database the Job runs `yarn command:prod upgrade` and nothing before it.
That one command runs the whole sequence in version order, *instance* and *workspace* steps interleaved.
`yarn database:init:prod` runs only when the database is empty (no `core` schema), exactly as the upstream entrypoint gates it.

Never run `database:init:prod` ahead of `upgrade` on an existing database.
It ends in `run-instance-commands --force`, which executes and records every *instance* step up to the newest version.
`upgrade` then resumes after the newest recorded step, not from each workspace's own position,
so every *workspace* step that sits between instance steps is skipped.
Nothing fails, and `upgrade:status` still reports the workspace as up to date.

That is what happened on the 2.32 to 2.40 jump on 2026-09-14:

* About fifty workspace steps were skipped.
* One was the 2.38 company-domain normalization.
  Contact auto-creation matches companies on the bare domain, so email and calendar sync created duplicates of existing companies.
* The Job had run both commands in that order since it was written; infra#1074 moved it to the gated form.

Workspace commands are where per-workspace metadata is reshaped: field backfills, view and layout provisioning, schema syncs.
Skipping them leaves instance schema at the new version and workspace metadata at the old one,
which surfaces as missing fields and broken views rather than as a failed deploy.

### Re-Running Does Not Recover A Skipped Step

Re-running the Job is safe, but it only moves forward.
Its start cursor is already past a skipped step, so the step never runs again on its own.

Run a skipped workspace step by name instead, dry run first:

```sh
yarn command:prod upgrade:2-38:normalize-company-domain-names --dry-run
```

Every workspace command accepts `--dry-run` and logs what it would change.
Dry runs of a *chain* can fail spuriously: a later step may check for a column that an earlier step creates, and a dry run creates nothing.

To run one in production, start `twenty-migrate` from its own template with only the command replaced.
Overriding with `--command`/`--args` drops the Job's environment, and the run dies connecting to `127.0.0.1:5432`:

```sh
az containerapp job show -n twenty-migrate -g qr-twenty-rg --query properties.template -o json > template.json
jq '{containers: [.containers[0] | .command = ["/bin/sh"] | .args = ["-c", "yarn command:prod <command> --dry-run"]]}' \
  template.json > run.yaml
az containerapp job start -n twenty-migrate -g qr-twenty-rg --yaml run.yaml
```

The template holds secret *references*, not values, so writing it to disk exposes nothing.
Read the output in Log Analytics, table `ContainerAppConsoleLogs_CL`, filtered on `ContainerGroupName_s startswith '<execution name>'`.
Allow about 90 seconds for ingestion.

Starting a Job can override its command and image, so anyone who can start `twenty-migrate` can run arbitrary code as Twenty's identity.
Treat the start permission accordingly.

### Version Jumps

Upgrading several minor versions at once is supported.
`TWENTY_PREVIOUS_VERSIONS` lists every version the current release can upgrade from, and the sequence runs all intermediate steps in order.
Check that the version being upgraded *from* is in that list before assuming a jump is safe.

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
