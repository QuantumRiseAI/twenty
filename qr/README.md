# Quantum Rise Fork

Everything in this directory is fork-only.
Upstream has nothing here, so it never conflicts on a rebase.

The fork tracks upstream *releases*, not upstream `main`.
A release tag is a point upstream has run its own full CI against, which is most of the confidence this fork gets for free.

## What The Fork Carries

Four changes in `twenty-server` and one in `twenty-front`.
The server changes are inert by default, so an unconfigured deployment behaves exactly like upstream.
The front-end change is copy only.

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
* Clearer 2FA code prompt at sign-in (`SignInUpTwoFactorAuthenticationVerification.tsx`, title in `SignInUp.tsx`)
  - Upstream says "Verify code from the app" and "Paste the code below", which never says which app.
  - The "Back" link is hidden for users who are already enrolled, since it led to the QR setup step they never saw.
  - The text is English in every locale, since no translation exists for it.
  - The committed catalogs in `twenty-front/src/locales` are left alone: the Dockerfile runs `lingui extract` and `compile` at build time, and upstream's own catalogs lag its source anyway.
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

## Deploying And Operating

Everything about running this fork in production lives in the infra docs, on the [Twenty page](https://infra.quantumrise.app/apps/twenty), under "Upgrades".
That covers the deploy steps from pre-flight to verification, the pre-upgrade dump and rollback, one-off commands in the migration Job, recovering skipped upgrade steps, and the Postgres extension trap.
This README stops once the fork's `main` holds the release.
