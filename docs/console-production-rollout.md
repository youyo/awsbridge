# Rolling out console login in production

English | [日本語](console-production-rollout_ja.md)

This page is for the operator of a downstream repository ([Upstream and downstream](../README.md#upstream-and-downstream)). It gives the order in which console login goes into production, the checks of each step with their expected results, and the checklist to finish before an Administrator role exists in a production account. How to carry out each operation is in the README; this page links to it and adds what to check and when to stop.

**The steps are bound by order, not by time.** Do not start a step until every check of the previous step has its expected result and the result is recorded.

## How to use this checklist

- Record the result of every check: the time, who ran it, and the output. The console tools redact account IDs and emails; raw `aws` output is not redacted (for example `describe-organization` shows the management account's ID and email), so redact it yourself before you put it in a record that others read. Keep the records in a private place of the downstream repository, never in the upstream. The decision in step 5 is made from them.
- **Stop rule (every step):** when a check does not give its expected result, set the var `LOGIN_DISABLED` to `true` on the Worker concerned and deploy, confirm that issuing returns `503 login_disabled`, then investigate. Do not go on to the next check. Continue only after the cause is fixed and the check passes when run again, or after your technical decision maker decides. In steps 0 and 1 no Worker exists yet: a check that fails there simply stops the rollout until it is settled. This is the same handling as for reconciliation errors in [Reconciling console logins](../README.md#reconciling-console-logins-issue-records-x-cloudtrail); the stop methods are in [Stopping issuance](../README.md#stopping-issuance-console-login).
- `LOGIN_DISABLED` stops new issuance only. Sessions already issued and `aws login` keep working; add revoke (L3) when those must stop too.
- **A person runs every key operation on their own machine**: `console:standard-key:put`, `console:admin-key:put`, `console:secrets:standard`, `console:secrets:admin`, and the `retire` tasks. Do not hand them to an agent, CI, or someone else's terminal. The same person deploys the Admin Worker.
- What the upstream measured holds for the mechanism (how the Workers, keys, and stops behave). Everything tied to your environment (account, zone, tokens, hosts, the deployed Workers) is checked again here.

## Step 0: Bring in the latest upstream

- [ ] Pull the upstream and record the commit you pulled. Every later result refers to this commit. If you pull again during the rollout, record the new commit and run the checks of the current step again.
- [ ] The commit has what the checks below rely on: the default deploy route `versions upload` + `versions deploy` ([How the Worker is deployed](../README.md#how-the-worker-is-deployed-default-route-and-explicit-route)), a reconciliation that reports `assume_time_gap`, `identity_mismatch`, and `identity_not_compared_admin` as errors and prints the lines `excluded assumes (not console)` and `admin issues`, and the task `console:exposure-check` ([Checking the console issuers from outside](../README.md#checking-the-console-issuers-from-outside-daily)). If one is missing, do not go on with that version.
- [ ] Your console wrangler configs (`wrangler.<name>-console.jsonc`, `wrangler.<name>-console-admin.jsonc`) set `workers_dev` and `preview_urls` to `false` and serve the hosts with Custom Domains ([Hosts](../README.md#hosts)).

```bash
git pull --no-rebase upstream main
git rev-parse upstream/main          # record this commit
mise tasks | grep console:           # console:reconcile and console:exposure-check are listed
```

## Step 1: Check the target account

Run these in each account that will get console login, with a read-only profile for a principal other than the console roles.

- [ ] **Not the management account of an Organization.** Expected: the `MasterAccountId` of `aws organizations describe-organization` differs from the `Account` of `aws sts get-caller-identity` (or the account is not in an Organization). If `describe-organization` is refused for lack of permission, confirm it another way (for example ask the administrator of the Organization) and record how you confirmed it. If it is the management account, stop: do not set up console login there, and escalate to your technical decision maker.
- [ ] **No role with a console role name.** Expected: `aws iam get-role` returns `NoSuchEntity` for every role name in your config (for example `FederatedAwsBridgeViewer` and `FederatedAwsBridgeAdministrator`), and no role is under the path `/awsbridge-console/`. If one exists, stop and find out who made it; do not adopt or overwrite it.
- [ ] **No console OIDC provider yet.** `aws iam list-open-id-connect-providers` lists no provider for your console issuer hosts. Save the output as the baseline (it contains the account ID: keep it in `.secrets/`, never in a public repository).
- [ ] **The MCP relay is left alone.** Write down the status of the MCP stack (`AWSBRIDGE_STACK_NAME`) and the ARN of the MCP provider. The console stacks have other names (`awsbridge-console-base`, `awsbridge-console-kind-<kind>`, and a separate name for the Administrator stack) and never update the MCP stack or its provider. After each later step, confirm both are unchanged.
- [ ] **Leftover check.** `mise run poc:g2:clean-check` is a read-only tool written for the upstream's trial environment. Expected: exit code 0 and no `NG` line. Its limits: it recognizes provider hosts only by the README's example prefixes (`awsbridge-console.`, `awsbridge-oidc-console.`, `awsbridge-admin-console.`, `awsbridge-oidc-admin-console.`), so with other host names compare against the baseline by eye; it checks only the stacks you name with `--stack`; and its Cloudflare part is `SKIP` without its read token, still with exit code 0.

```bash
aws sts get-caller-identity --profile <read-only profile>
aws organizations describe-organization --profile <read-only profile>
aws iam get-role --role-name FederatedAwsBridgeViewer --profile <read-only profile>          # NoSuchEntity
aws iam get-role --role-name FederatedAwsBridgeAdministrator --profile <read-only profile>   # NoSuchEntity
aws iam list-roles --path-prefix /awsbridge-console/ --profile <read-only profile>            # no roles
aws iam list-open-id-connect-providers --profile <read-only profile> > .secrets/providers-before.json
mise run poc:g2:clean-check -- --profile <read-only profile> --baseline .secrets/providers-before.json \
  --stack awsbridge-console-kind-default
```

## Step 2: Standard and Viewer only

Set up the Standard tier with the Viewer role, following steps 1 to 6 of [Order of the first setup (console login)](../README.md#order-of-the-first-setup-console-login). In this step the config has no Admin-tier team and no Administrator role, nothing of Admin is deployed, and the base stack gets no `AdminIssuerHost`. Deploy the Standard Worker with `LOGIN_DISABLED` set to `"true"` and keep it there until the checks below pass.

- The first deployment, and any change of a Custom Domain, takes the explicit route with a short-lived token of your own that has the zone permissions; discard it afterwards ([How the Worker is deployed](../README.md#how-the-worker-is-deployed-default-route-and-explicit-route)). Before you discard it, check once with it that no Route hits the four hosts, as in [Checking the console issuers from outside](../README.md#checking-the-console-issuers-from-outside-daily) (all pages, wildcards included; a list that cannot be read is not 0 Routes).
- Daily deploys of the Standard Worker use a token that is "Individual Workers Editor for the Standard Worker only, no zone permissions". The Admin Worker gets its own token in step 4.

### Before the first issuance

With `LOGIN_DISABLED` still `"true"`:

- [ ] `mise run console:standard-key:check`: no `[NG]` (the binding is a `secret_key`, the discovery and JWKS match the vars, the key cannot be extracted, `exportKey` fails, the self-verification passes). If the binding is not a `secret_key` or `exportKey` succeeds, stop and escalate to your technical decision maker.
- [ ] `mise run console:access:inspect`: 0 errors (Cookie Path enabled on the entry application and on every team application; [Access applications](../README.md#access-applications-for-console-login-cookie-path)).
- [ ] **workers.dev and Preview URLs do not answer.** Neither the Worker's workers.dev URL nor a Preview URL returns a response of the Worker (no portal page, no JSON, no issuer document); a 404 or a Cloudflare error page is expected. These would be entrances that skip Access: if one answers, fix `workers_dev` / `preview_urls`, deploy on the explicit route, and check again.
- [ ] **The daily token is limited to the Standard Worker.** With that token, try once to add a Worker Route for each of the four hosts (the portal and the issuer, for Standard and for Admin, even before the Admin hosts exist), for example with a `POST` to the zone's Workers Routes API (`/zones/{zone_id}/workers/routes`). Expected: 403 every time. If the Admin Worker already exists, also try one write to it with this token (for example `wrangler versions upload` with the Admin wrangler config): 403. If any attempt succeeds, delete what it created at once, treat the token's scope as wrong (revoke it and make a new one), and check again.
- [ ] **The default route keeps the settings.** Deploy once on the default route without changing anything that matters (for example only a deploy message), and compare before and after: vars, the `secret_key` bindings, Custom Domains, the Workers Logs (observability) settings, `workers_dev` and `preview_urls` (both still `false`), and `LOGIN_DISABLED` are all unchanged. Then run `mise run console:standard-key:check` again: no `[NG]`. This is the first check that the Standard key survives the default route; the upstream measured it only on the Admin Worker.
- [ ] `AWSBRIDGE_CONSOLE_LOGS_WORKERS` lists the names of both console Workers as your downstream wrangler configs name them (the default is the upstream names, which are not yours). Listing the Admin name before the Admin Worker exists is expected to be harmless (the query filters by Worker name), but this has not been verified: the first `console:reconcile` with `--logs-api` below must read the records successfully (`source: api`, not exit code 2).
- [ ] `mise run console:exposure-check`: exit code 0 and `[OK]` for every Standard boundary. It says that Admin is skipped (no `worker.admin.json`); that is expected in this step only.
- [ ] After the base stack and the role stacks: `mise run console:inspect -- --profile=<p>` reports 0 errors, and the MCP stack and provider are unchanged.

### On the day of the first issuance

Set `LOGIN_DISABLED` to `"false"`, deploy, and record the time (T0). Issue for the Viewer from the portal (and with `aws login` if you use it), and record how many issuances you made. Wait until CloudTrail has the events. Allow about 30 minutes as a guide; the tool leaves records newer than its propagation lag (default 300 s, `--lag-seconds`) as `pending`, so if they are not settled yet, wait longer and run again. Then on the same day:

- [ ] **workers.dev and Preview URLs still do not answer** after the deploy that set `LOGIN_DISABLED` to `"false"` (the same check as before the first issuance).

- [ ] `console:reconcile` (command below): exit code 0 and `errors: 0`; `regions: read <n>/<n>` with both numbers equal; `unverifiable: 0, truncated lines: 0, unreadable lines: 0, pending: 0` (with `pending` above 0, `matched` falls short of your issuances); `matched` equal to the console assumes and to the number of your issuances (each `jti` matched one to one); `identity: compared <n>, not compared 0 (admin 0)`; `excluded assumes (not console)` at its expected value (0 when MCP is not used in the account; otherwise only the MCP roles, checked as in the README); `coverage: first run`. Read every warning.
- [ ] **One `aud` per request.** Logging in through the entry and through each team path works (the Worker accepts an Access JWT with exactly one `aud`). A request to `/t/<team>/key-check` sent with a token of the entry application is refused with `403 unknown_audience`, and one sent with a token of another team's application with `403 team_mismatch` (if Access does not refuse it first). Expected: both are refused, and neither returns the key-check's 200 JSON.
- [ ] `mise run console:exposure-check`: exit code 0.

```bash
mise run console:reconcile -- --profile <p> --logs-api --since <T0 minus 5 minutes>
mise run console:exposure-check
```

## Step 3: At least one clean day of daily checks

From the day after the first issuance, run the two daily checks in [Daily operations](../README.md#daily-operations).

- [ ] At least one daily run after the first-issuance day in which `console:reconcile` exits with 0, shows `errors: 0`, and shows `excluded assumes (not console)` at its expected value, and `console:exposure-check` exits with 0.
- On an error, follow the stop rule and the handling in [Reconciling console logins](../README.md#reconciling-console-logins-issue-records-x-cloudtrail). An unexpected excluded count is investigated as described there. The clean day counts only after the cause is settled.

## Step 4: Admin Worker and Admin provider, without the Administrator role

Follow steps 1 to 5 of the first deployment in [Admin signing key for console login](../README.md#admin-signing-key-for-console-login), and from its step 6 only the provider: pass `AdminIssuerHost` to the base stack. **Do not create the Administrator role in this step.**

- Add the Admin-tier team and the Administrator role to the config, assign the Administrator to that team in the kind (`assign`), and regenerate (`worker.admin.json` appears). Because of that `assign`, the generated `stacksets.json` now gives the kind a non-empty `AdministratorTeams`. **Do not pass it to the Viewer stack**: keep `AdministratorTeams` empty there, and look at the change set of every update of that stack; if `AdministratorRole` appears, do not execute it.
- The Standard Worker's list now shows the Admin rows: redeploy it on the default route and run `mise run console:standard-key:check` again.
- The person who runs the key operations makes the Admin deploy token ("Individual Workers Editor for the Admin Worker only, no zone permissions", separate from the Standard token), keeps it, and deploys the Admin Worker from their own machine.

Checks:

- [ ] `mise run console:admin-key:check`: no `[NG]`. If the binding is not a `secret_key` or `exportKey` succeeds, stop and escalate to your technical decision maker.
- [ ] The Admin Worker's workers.dev and Preview URLs do not answer (as in step 2), and the Admin issuer serves its discovery and JWKS (with an Access Bypass on those two paths if Access covers the host).
- [ ] `mise run console:access:inspect`: 0 errors, now including the Admin applications.
- [ ] **`aud` between the tiers.** A token of a Standard team application does not open the Admin team's `/t/<team>/key-check`, and a token of an Admin team application does not open a Standard team's: refused by Access or by the Worker with `403 unknown_audience`, and no 200 JSON in either direction.
- [ ] **Both daily tokens are limited.** With the Admin token: one write to the Standard Worker and a Route for each of the four hosts give 403. With the Standard token: one write to the Admin Worker gives 403 (it exists now). On a success, the same handling as in step 2.
- [ ] **The default route keeps the Admin settings.** The same before-and-after comparison as in step 2 on the Admin Worker, then `mise run console:admin-key:check` again: no `[NG]`.
- [ ] `AWSBRIDGE_CONSOLE_LOGS_WORKERS` includes the Admin Worker, and `mise run console:exposure-check` exits with 0 with `[OK]` for the Admin issuer (no longer skipped).
- [ ] `mise run console:inspect -- --profile=<p>`: the Admin provider exists (no `provider_missing`), and the only expected error is `role_missing` for the Administrator role, which is created in step 5. The tool checks guard policies only on roles that exist, so the Admin guard policy on the Administrator role is checked in step 5, not here.
- [ ] The daily checks stay clean, and `admin issues` shows nothing you did not do. The MCP stack and provider are unchanged.

## Stopping drill (before step 5)

Do this once before the decision in step 5. Each stop is complete when a request is refused, not after a fixed time ([Stopping issuance](../README.md#stopping-issuance-console-login)).

- [ ] **Viewer.** The stop switch: `LOGIN_DISABLED` set to `true` on the Standard Worker makes issuing return `503 login_disabled`; then set it back. Stopping one person: `mise run console:stop:apply` with your own SourceIdentity makes requests of your Viewer session fail ([Stopping one person](../README.md#stopping-one-person-for-console-login)). It needs `--stops`, `--reason`, and `--yes` to write, and you run it from another entry point (such as IAM Identity Center), not from a session of a console role. Revoke (L3) on the Viewer role refuses sessions issued before it. Releasing the one-person stop must wait for the release conditions (at least the role's `MaxSessionDuration`), so plan the drill over two days.
- [ ] **Administrator inventory.** Run steps 2 to 4 of [Inventory of what an Administrator left behind](../README.md#inventory-of-what-an-administrator-left-behind-console-login) once (providers, CloudTrail, the IAM listing). The Administrator role does not exist yet, so skip its step 1. Keep the listing as the baseline to compare with after an Administrator has been used (it contains account IDs; never put it in a public repository). Check whether `sourceIdentity` appears on the events of operations made in your Viewer session; if it does not, the inventory has to pick events another way, as the README says.

## Step 5: Decide before adding Administrator

**Stop here.** Adding the Administrator role to a production account needs the approval of a person, made from the records. The technical review of your decision maker does not replace it.

### What the decision needs

- [ ] The results of steps 0 to 4 and of the drill, each with its expected result, and how every deviation was settled.
- [ ] The account and its Organization: which Organization the account belongs to, that it is not the management account, who administers the Organization, and which controls (such as SCPs) apply to the account.
- [ ] Where the signing keys are: the Cloudflare account that holds the Admin Worker and its `secret_key`, who can change the Admin Worker (code, vars, secrets), and who holds tokens that can change the zone of the issuer hosts (DNS, Routes, Custom Domains). Anyone on these lists can sign an Administrator JWT or replace an issuer.
- [ ] The accepted limits, read and accepted by the person who approves: the issue records are written by the Admin Worker itself, so against anyone who can write to the Admin Worker the reconciliation is not independent detection ([Reconciling console logins](../README.md#reconciling-console-logins-issue-records-x-cloudtrail)); watching the zone's configuration is the zone owner's operation, and the comparison from the outside is detection, not prevention ([Checking the console issuers from outside](../README.md#checking-the-console-issuers-from-outside-daily)).
- [ ] The approval itself, with its date and the commit from step 0.

### After the approval: the Administrator stack

Create the Administrator role as in step 6 of [Admin signing key for console login](../README.md#admin-signing-key-for-console-login):

- [ ] A **separate stack** whose name does not match `awsbridge-console-kind-<kind>` (for example `awsbridge-console-admin-default`), with only `AdministratorTeams` set.
- [ ] The creation change set contains **only an `Add` of `AdministratorRole`**. Otherwise, do not execute it.
- [ ] Right after the creation and before the first issuance: `aws iam get-role` shows a trust policy that names only the Admin provider, and `aws iam list-attached-role-policies` shows the Admin guard policy attached. Otherwise, abort (below).
- [ ] In the Viewer stack (for example `awsbridge-console-kind-default`), `AdministratorTeams` stays empty. Before every update of it, look at the change set; if `AdministratorRole` appears, do not execute it.
- [ ] `mise run console:inspect -- --profile=<p>`: 0 errors (no more `role_missing`).
- [ ] After the first Administrator issuance, on the same day: `console:reconcile` shows `errors: 0`, `admin issues: 1` at the time of your issuance, and `admin 0` in the identity line; `console:exposure-check` exits with 0.
- To abort: **delete the Administrator stack, and remove the Administrator from the config and regenerate**, so that the generated files and the portal list do not keep it.
- To stop Administrator assumptions without Cloudflare: [Stopping only the Admin provider (L2)](../README.md#stopping-only-the-admin-provider-l2) and [Denying in the role trust policy](../README.md#denying-in-the-role-trust-policy). While a trust-policy Deny is in place, do not update the stack: whether an update that changes the trust policy removes the Deny has not been measured.
