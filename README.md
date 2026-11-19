# awsbridge

English | [日本語](README_ja.md)

Bridge AI agents to AWS.

awsbridge turns the identity of a user authenticated by Cloudflare Access into per-user temporary AWS credentials. It runs as Cloudflare Workers that are their own OIDC issuers: a Worker signs a short-lived JWT for the user, and AWS STS (`AssumeRoleWithWebIdentity`) exchanges it for credentials of a role in the target account. No long-lived AWS access keys are stored in the Workers.

> Early development stage. The design documents are in [docs/specs/](docs/specs/) (written in Japanese): [architecture.md](docs/specs/architecture.md) for the MCP relay, and [console-login.md](docs/specs/console-login.md), [console-login-portal.md](docs/specs/console-login-portal.md), and [console-login-admin.md](docs/specs/console-login-admin.md) for console login. Some steps below are marked as not run or not measured yet; take those as examples.

Predecessor: [youyo/aws-mcp-gateway](https://github.com/youyo/aws-mcp-gateway)

## What awsbridge does

awsbridge has two features. Each has its own Worker, issuer, IAM OIDC provider, audience, and roles, and you can use either one alone.

1. **MCP relay** (`src/index.ts`, [`wrangler.jsonc`](wrangler.jsonc)): converts the identity of the user into per-user temporary AWS credentials (STS), signs requests with SigV4, and relays them to the AWS MCP Server. It is designed to sit behind a Cloudflare MCP Portal. The `aws_profile` argument switches between AWS accounts.
2. **Console login** (`src/console/`, [`wrangler.console.jsonc`](wrangler.console.jsonc)): people open a portal behind Cloudflare Access and sign in to the AWS Management Console, or to the CLI with `aws login`. One Worker serves the entry, the list of accounts and roles, and issuing for every role, with one issuer, one signing key, and one OIDC provider per boundary. Teams and roles have a tier:
   - **Standard** (for example a Viewer): `aws login` works on the same device and with `--remote`.
   - **Admin** (for example an Administrator): its teams have their own Access applications with a short session, its roles live under their own path with a 1-hour `MaxSessionDuration` and a Deny of `aws login --remote`, the pages of its teams carry an Admin mark and an Administrator is issued only from the login page of an Admin team (the confirmation screen; the entry list only links to it), and the reconciliation treats it more strictly.

   The tier does not separate the Worker, the issuer, the key, or the host; the only things that separate the tiers when issuing are the team and the team condition in the role trust policy (acceptance d below). It does not guarantee how strong a role is (`docs/specs/console-login.md` §3.3).

The MCP roles (`FederatedAwsBridgeMcpViewer` / `FederatedAwsBridgeMcpDebugger`) are separate from the human console roles (for example `FederatedAwsBridgeViewer` / `FederatedAwsBridgeAdministrator`). Granting a person a console role does not change what the MCP roles can do.

Stages in this README follow the rollout plan in `docs/specs/console-login.md` §7: stage 1 completes the code, stage 2 is a trial in a personal environment, and stage 3 is the rollout to a company. The steps of a production rollout in a downstream repository are in [Rolling out console login in production](docs/console-production-rollout.md).

## Before using console login (accepted limits)

> **Anyone who can deploy the console Worker, or who can touch its secrets or dependencies, holds full control of every account where Administrator is deployed.**
>
> Console login issues Viewer and Administrator from one Worker, one issuer, one signing key, and one OIDC provider (per boundary; separate from the MCP relay). Before using it, accept the following.
>
> a. The whole console Worker is the authority that issues Administrator. Any one of the Worker's deploy permission, its secrets (the signing key bindings, the CSRF key), or its dependencies (npm dependencies, build tools) reaches full control of every account where Administrator is deployed. This holds even for a change made only for Viewer.
> b. Only people allowed to issue Administrator deploy the Worker and operate the keys. Handing this to an agent, CI, or anyone else hands them full control.
> c. The scripts of the entry page, the lists, and the screens run on the same origin as Administrator issuance (with path routing, the default). A flaw in a screen can trigger Administrator issuance from the browser of a person who has an Access session for an Admin team. The confirmation screen does not stop this.
> d. The only things that separate Viewer from Administrator are the team the Worker derives from the Access application's AUD, the session tag that carries that team, and the team condition in the role trust policy. On the AWS side, the issuer, the key, and the audience do not distinguish tiers. Do not reuse a team name across tiers.
> e. Deleting the OIDC provider stops both Viewer and Administrator. The ways to stop only Administrator without relying on Cloudflare are a Deny in the Administrator role's trust policy and deleting the Administrator stack.
>
> One Worker separates authority between the tiers, not availability. A broken key setting (for example one key in two boundaries, or a current kid missing from the public keys, which is what removing the current kid does) makes every route of the Worker return `500 server_misconfigured`: the portal and the issuer documents of every boundary, for both tiers.
>
> The issue records are written by this Worker itself, so against anyone who can write to this Worker, the reconciliation with CloudTrail is not independent detection.
>
> The ways to stop issuance (the stop switches, removing a kid, deleting the provider, a Deny in the trust policy) only stop new issuance and new assumptions; they do not stop sessions already issued. Revoking the role is what stops sessions already issued.
>
> The age limit of the Access JWT for Admin teams (default 15 minutes) is the time since the JWT was issued, not the time since the user authenticated. Whether re-authentication is required is decided by the Access and IdP settings.
>
> Anyone who can read Workers Logs can read the issue records (masked). Treat permission to read the logs with the same weight as permission on this Worker.
>
> The ledger of retired team names (below): The ledger guards against operator mistakes, not against anyone who can write the config; deleting the artifacts and passing the first-run flag (`--ledger-init`) removes it. The old roles in an account that has left management are not visible to `mise run console:inspect` either; the ledger is the only guard there.

When you change a team's tier, use a new name (do not reuse a name in another tier: a name left in an old stack's trust policy would let people of another tier in). When you remove a team, move it to `retiredTeams` (the ledger of retired team names) in the config. `mise run console:config:generate` treats as an error using a ledger name for a current team, removing a name from the ledger, removing a team without moving it to the ledger, and changing the tier of a team with the same name. The procedure is in "Ledger of retired team names" under "Console login setup".

## Upstream and downstream

This repository is the **upstream**. It is open source and holds only the code, the templates, the tools, and example configurations whose values are placeholders (`example.com`, `111111111111`). You do not run production from it.

Production runs from a private **downstream** repository: a clone of awsbridge that keeps awsbridge as the `upstream` remote and adds its own files. Real hosts, account IDs, emails, and keys live only there (and secrets only in gitignored files).

| | Upstream (this repository) | Downstream (private) |
|---|---|---|
| Holds | Workers, CloudFormation templates, reference Terraform, mise tasks, examples (`config/*.example.json`, `wrangler*.jsonc` with `example.com`) | `wrangler.<name>.jsonc` (MCP), `wrangler.<name>-console.jsonc` (console login), `mise.<name>.toml`, `.miserc.toml`, `deploy/profiles.json`, the console config (for example `deploy/console.json`) |
| Never holds | real hosts, account IDs, emails, keys | edits to upstream files (only new files, so `git pull` does not conflict) |
| Secrets | none | `mise.local.toml` and `.secrets/` (gitignored, never committed) |

The setup order for a downstream repository is in "Operating in a downstream repository".

## Architecture

The Cloudflare side (Workers) and the AWS side (CloudFormation) are completely separate. Deploying a Worker does not call AWS, and deploying CloudFormation does not call Cloudflare. For each target AWS account, you only need to run CloudFormation. An AWS account trusts an issuer only through its IAM OIDC provider, and each issuer host is served by one Worker.

### MCP relay

```
MCP client (for example Claude)
  │
  ▼
Cloudflare MCP Portal ─▶ Cloudflare Access (application on the connection host)
  │  https://awsbridge-mcp.example.com/mcp
  ▼
MCP Worker (wrangler.jsonc)
  │ 1. verify the Access JWT (ACCESS_AUD) and take the email
  │ 2. sign a 5-minute JWT with SIGNING_JWK (issuer = AWSBRIDGE_ISSUER)
  │ 3. STS AssumeRoleWithWebIdentity on the role of the selected aws_profile
  │ 4. sign the request with SigV4 and relay it
  ▼
AWS MCP Server ─▶ AWS APIs of the target account

STS reads https://awsbridge-oidc-mcp.example.com/.well-known/* (public; served by the same Worker)
Each target account: infra/aws/awsbridge.yaml (IAM OIDC provider + the two MCP roles)
```


### Console login

```
Browser or terminal of a person
  │
  ▼
Cloudflare Access (an entry application and one application per team at /t/<team>;
                   the applications of Admin-tier teams have a short session)
  │
  ▼
Console Worker (wrangler.console.jsonc), one Worker for both tiers
  │ portal  https://awsbridge-console.example.com                  entry, the list, issuing at /t/<team>
  │ issuer  https://awsbridge-oidc-console.example.com/console     discovery and JWKS only
  │ keys    secret_key per boundary (CONSOLE_KEY_*), used for both tiers
  │ 1. verify the Access JWT (exactly one aud) and decide the team from its AUD (and the tier from the team)
  │ 2. sign a 5-minute JWT (aud awsbridge-console, the team in a session tag)
  ▼
STS AssumeRoleWithWebIdentity in the target account
  │ trust policy: the console provider, aud awsbridge-console, the team tag (teams of the role's tier only), SourceIdentity required
  ▼
getSigninToken ─▶ AWS Management Console (or aws login)

Each target account: the base stack infra/aws/console/base.yaml (one OIDC provider per boundary + guard policies of both tiers)
                     + role stacks generated from the console config (kind.<kind>.yaml); the Administrator role in a separate stack
Issue records (console_issue) ─▶ Workers Logs ─▶ mise run console:reconcile (with CloudTrail)
```

- The Worker decides the team only from the AUD of the Access application the request came through, and puts it in a session tag. AWS decides who may enter which role through the role's trust policy. The mapping of teams and kinds of accounts to roles lives in the console config and the role stacks, not in the Worker.
- A boundary is a trust boundary (`managed`, or `partner:<id>` for an unmanaged partner). Each boundary has its own issuer, key, and provider, shared by the Standard and the Admin tier.
- The tier stays as a classification of teams and roles. It decides the Access application of the team (the session of Admin-tier teams is short, and the Worker also limits the age of their Access JWT), the role path (`/awsbridge-console/std/` or `/awsbridge-console/admin/`), the shape of the role (`MaxSessionDuration` of exactly 1 hour and no `aws login --remote` for the Admin tier), the guard policy, the confirmation screen, and how the reconciliation treats the issuance.

### Hosts

| Host (example) | Worker | Purpose | Access |
|---|---|---|---|
| `awsbridge-mcp.example.com` | MCP | MCP connection (`/mcp`) | Protected. Its AUD is the Worker's `ACCESS_AUD` |
| `awsbridge-oidc-mcp.example.com` | MCP | MCP issuer (`/.well-known/*`) | Public (STS reads it). Any other path returns 401 |
| `awsbridge-console.example.com` | Console | Portal (entry and `/t/<team>` for the teams of both tiers) | Entry and team applications, Cookie Path enabled |
| `awsbridge-oidc-console.example.com` | Console | Console issuer (`/console`; `/p/<id>/console` for a partner) | No Access application (STS reads it). Paths other than the issuer documents return 404 |

- The production configurations (the console Worker and `env.prod` of the MCP Worker) use Custom Domains on a zone of your Cloudflare account and set `workers_dev` and `preview_urls` to `false`, which closes the entrances that skip Access. Only the MCP trial configuration `env.dev` uses workers.dev.
- The `awsbridge-oidc-` prefix marks a host that is only an issuer and says whose it is, so that when another OIDC mechanism is later set up on the same domain, the owner of each issuer is clear.
- **An issuer host is what the IAM OIDC provider trusts.** Whoever takes it over can issue tokens that AWS accepts. Keep the domain's auto-renewal on, lock the domain at the registrar, and limit who can edit the zone (DNS, Routes, Custom Domains) and deploy the Workers.

## Operating in a downstream repository

Production use is expected to happen in a private downstream repository. You register awsbridge as `upstream` and keep pulling updates. **You never edit upstream files; you only add new files** to deploy to your own environment (so `git pull` does not conflict). In the following, `<name>` is the environment name (for example `awsbridge-mcp`).

### Order of the first setup

1. Create the downstream repository and add its files (steps 1 to 4 below).
2. MCP relay: follow "Order for the first deployment" in "MCP relay setup".
3. Console login (optional, and possible later): follow "Order of the first setup (console login)" in "Console login setup". Start with the Standard tier (Viewer) only, and add the Admin tier only after the checks of [Rolling out console login in production](docs/console-production-rollout.md).
4. Once console login is live, start the daily checks in "Daily operations".

### Steps

1. Create the downstream repository and bring in the upstream.

```
git clone <awsbridge URL> my-awsbridge && cd my-awsbridge
git remote rename origin upstream
git remote add origin <private repository URL>   # The downstream push destination
```

2. Add `wrangler.<name>.jsonc` for the MCP Worker (commit it. Role ARNs are not secrets). Keep `main` and the others the same as the upstream `wrangler.jsonc`, and customize only `name` / `workers_dev` / `preview_urls` / `routes` / `alias`. `alias` replaces the module `awsbridge:profiles` with your profile list JSON (`deploy/profiles.json`, described right after the example). Do not use the env section (the values are dummies).

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "awsbridge-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-21",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "workers_dev": false,
  "preview_urls": false,
  "routes": [
    { "pattern": "awsbridge-mcp.example.com", "custom_domain": true },
    { "pattern": "awsbridge-oidc-mcp.example.com", "custom_domain": true }
  ],
  "alias": { "awsbridge:profiles": "./deploy/profiles.json" }
}
```

   `awsbridge-mcp.example.com` is the MCP connection host and `awsbridge-oidc-mcp.example.com` is the issuer host (`AWSBRIDGE_ISSUER=https://awsbridge-oidc-mcp.example.com`); replace both with your own domain. For a workers.dev trial, set `workers_dev` to `true` and remove `preview_urls` and `routes`.

   The format of `deploy/profiles.json` is the same as the JSON in "Multi-account" (commit it. Role ARNs are not secrets). Copying the upstream `config/profiles.example.json` and rewriting it is the quickest way.

   For console login, add `wrangler.<name>-console.jsonc` the same way, starting from the upstream `wrangler.console.jsonc` and replacing `routes` and `vars` with your values (keep `alias` pointing at the generated files in `.generated/console/`), and add your console config (for example `deploy/console.json`, starting from `config/console.example.json` or `config/console.company.example.json`). See "Console login setup".

3. Add the downstream mise config files: `mise.<name>.toml` and the `.miserc.toml` that enables it (commit both. Do not put secret values in them).

```toml
# mise.awsbridge-mcp.toml
[env]
AWSBRIDGE_WRANGLER_CONFIG = "wrangler.awsbridge-mcp.jsonc"
AWSBRIDGE_WRANGLER_ENV = ""                      # Empty = do not add --env (if unset, the upstream's dev is used)
AWSBRIDGE_STACK_NAME = "awsbridge-mcp"
AWSBRIDGE_KEY_FILE = ".secrets/awsbridge-mcp-signing-key.json"   # Use a separate key per environment
# AWS_PROFILE = "<AWS CLI profile used for deployment>"
# AWSBRIDGE_AUDIENCE = "awsbridge"               # If you change it, also match the Worker's var STS_AUDIENCE
# Console login (only if you use it)
# AWSBRIDGE_CONSOLE_CONFIG = "deploy/console.json"
# AWSBRIDGE_CONSOLE_WRANGLER_CONFIG = "wrangler.awsbridge-mcp-console.jsonc"
```

```toml
# .miserc.toml
env = ["awsbridge-mcp"]
```

4. Write secret values and environment-specific values in `mise.local.toml` (gitignored. Do not commit it): `AWSBRIDGE_ISSUER` (the issuer URL, such as `https://awsbridge-oidc-mcp.example.com`), `AWSBRIDGE_ALLOWED_SUBJECTS`, `AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS`, `AWSBRIDGE_ACCESS_TEAM_DOMAIN`, `AWSBRIDGE_ACCESS_AUD`, and so on (see "Variables in `mise.local.toml`"), plus the console tool variables listed in each console section. The profile list goes in `deploy/profiles.json`, not in `mise.local.toml`.

5. Deploy the MCP relay (first time). The full order, including Cloudflare Access, is "Order for the first deployment" in "MCP relay setup".

```
mise run keygen                                               # Generate the signing key at AWSBRIDGE_KEY_FILE
AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy mise run deploy:worker  # First deployment with wrangler.<name>.jsonc (creates the Worker and its Custom Domains) → register secrets
AWS_PROFILE=<target> mise run deploy:aws                      # Deploy CloudFormation per account, and write the outputs ReadOnlyRoleArn / DebugRoleArn into deploy/profiles.json
mise run deploy:worker                                        # Bundle the profile list (default route)
```

6. Pull in upstream updates.

```
git pull --no-rebase upstream main
```

### Notes

- **Keep signing keys separate per environment.** Do not reuse the same key and the same issuer as the upstream's development deployment (use a different path for `AWSBRIDGE_KEY_FILE`). You can swap keys without downtime by following "Signing key rotation (MCP relay)" (`mise run key:prepare` → `secrets` → wait → `key:activate` → `secrets` → wait → `key:retire` → `secrets`).
- **The issuer (the issuer URL) differs per environment**, so the CloudFormation stack that creates the IAM OIDC provider and roles is also separate per environment (use different values of `AWSBRIDGE_STACK_NAME`). When placing multiple environments in the same account, also separate the role names (`AWSBRIDGE_READONLY_ROLE_NAME` / `AWSBRIDGE_DEBUG_ROLE_NAME`).
- mise gives `mise.<name>.toml` precedence over `mise.toml`, and `mise.local.toml` precedence over `mise.<name>.toml`. `.config/mise/conf.d/*.toml` loses to `mise.toml`, so it cannot be used.
- The upstream `wrangler.jsonc` (`name: awsbridge` / `env.dev`) is for the upstream's development use. Do not use it downstream. The same goes for the upstream `wrangler.console.jsonc`, which is an example.

### Setup skill (Claude Code)

A Claude Code skill that interactively sets up a downstream private repository is bundled in `.claude/skills/setup-downstream/` (`.agents/skills/setup-downstream/` links to the same file). You can use it as is just by cloning awsbridge (on first use you will be asked to trust the folder).

```
git clone https://github.com/youyo/awsbridge <downstream repository name>
cd <downstream repository name> && claude
/setup-downstream <downstream repository name>
```

The skill guides you in order through re-pointing the remotes (`origin` → `upstream`), creating the downstream repository, deploying the Worker, CloudFormation, Cloudflare Access/Portal, and verification. It covers the MCP relay only, not console login. For operations that affect external systems, it asks for confirmation before running at each stage. The skill is version-controlled together with the code, so updates reach the downstream repository through `git pull --no-rebase upstream main`.

## How the Worker is deployed (default route and explicit route)

`scripts/wrangler.sh deploy` takes the **default route** unless you ask otherwise: `wrangler versions upload`, then it reads the Version ID from the output and runs `wrangler versions deploy <version-id>@100% --yes`. Only the code, vars and bindings of the Worker change. Custom Domains and Routes (triggers) are not synchronized, so the token needs no permission on the zone. A token that is "Individual Workers Editor for this one Worker, no zone permissions" is enough for daily deploys.

This applies to every Worker. `mise run deploy:worker` uses it for the MCP Worker. There is no mise task that deploys the console Worker; run `scripts/wrangler.sh` with the console wrangler config, as shown in "Console login setup" (`AWSBRIDGE_WRANGLER_CONFIG=<console wrangler config> AWSBRIDGE_WRANGLER_ENV= bash scripts/wrangler.sh deploy`).

- Why: a token with Workers Routes Write on the zone can add a Route to another Worker's Custom Domain host and take over its responses. Daily deploys therefore use a token without that permission.
- Arguments: `--var`, `--message`, `--tag`, `--outdir`, `--minify`, `--keep-vars` and the other options that `wrangler versions upload` accepts are passed on. `--config` and `--env` come from `AWSBRIDGE_WRANGLER_CONFIG` / `AWSBRIDGE_WRANGLER_ENV` as before. An option that `versions upload` does not accept (such as `--routes`) stops the script with an error; it is never dropped silently. If the Version ID cannot be read from the output, it exits 1 and does not run `versions deploy`.
- `deploy --dry-run` (used by the build tasks) still runs `wrangler deploy --dry-run`; nothing is written.
- **Explicit route**: set `AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy` to run `wrangler deploy`, which also synchronizes the triggers (Custom Domains, Routes) and the workers.dev / Preview URL settings. Use it for the first deployment (`versions upload` cannot create a Worker that does not exist yet) and whenever a Custom Domain or Route is added, changed or removed, including a change of `workers_dev` / `preview_urls`. Run it with a short-lived token of your own that has the zone permissions, and discard the token afterwards.

  ```
  AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy CLOUDFLARE_API_TOKEN=<short-lived token> mise run deploy:worker
  ```

- **Do not run `wrangler deploy` with a token that has no zone permissions.** It uploads the code first and fails only in the later triggers step, so the command exits with a failure code **even though the new code is already live**. Treat the failure as "deployed, but triggers not synchronized".
- `versions upload` does not change `workers_dev` or `preview_urls` of the Worker. These settings stay as the last explicit `wrangler deploy` set them, so make sure they are `false` there (the configurations in this repository fix both to `false`).
- A Worker's Custom Domains and Routes change only through the explicit route.

## MCP relay setup

### Prerequisites

- [mise](https://mise.jdx.dev/) (`mise install` installs the runtimes and cfn-lint)
- Cloudflare side: an account where you have run `wrangler login`
- AWS side: an AWS profile with permission to operate IAM and CloudFormation

### Decide the hosts (a custom domain is the basic form)

The Worker's issuer URL becomes the URL of the IAM OIDC provider, so decide the hosts first. The basic form puts the issuer and the MCP connection on separate hosts of your own domain (`example.com` below is a placeholder). One MCP Worker serves both, with two Custom Domains.

| Role | Example | Notes |
|---|---|---|
| OIDC issuer | `https://awsbridge-oidc-mcp.example.com` (no path) | `AWSBRIDGE_ISSUER`. STS reads `/.well-known/*` here, so it is public (an Access bypass if a wider Access application covers the host). Any other path, including `/mcp`, returns 401 here, because the Worker checks the Access JWT and requests to this host carry none |
| MCP connection | `https://awsbridge-mcp.example.com/mcp` | Where MCP clients connect. The Access application protects this host, and its AUD is the Worker's `ACCESS_AUD` |

- The Worker's configuration is `env.prod` in `wrangler.jsonc` (`routes` has the two `custom_domain` entries; `workers_dev` and `preview_urls` are `false`). Select it with `AWSBRIDGE_WRANGLER_ENV=prod`. A downstream repository copies it into its own `wrangler.<name>.jsonc` and replaces the hosts.
- The domain must be a zone on your Cloudflare account. Cloudflare creates the DNS records and certificates for the Custom Domains. Protect the issuer host as described in "Hosts".
- For a quick trial you can use workers.dev: the default `AWSBRIDGE_WRANGLER_ENV=dev` deploys `awsbridge-dev` to `https://<worker>.<subdomain>.workers.dev`, and that one host is both the issuer and the connection. Use a custom domain for real use.

### Order for the first deployment

The issuer URL becomes the OIDC issuer, so proceed in this order.

1. Cloudflare side: `mise run keygen` → set `AWSBRIDGE_ISSUER` (`https://awsbridge-oidc-mcp.example.com`), `AWSBRIDGE_WRANGLER_ENV` (`prod`) and the other variables in `mise.local.toml` → `cp config/profiles.example.json config/profiles.json` (required for the build. The contents can stay as dummies for now) → `AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy mise run deploy:worker` (the first deployment needs the explicit `deploy` route; see "How the Worker is deployed". This fixes the issuer URL. At this point the role ARNs are dummies, so `/mcp` is not usable). `deploy:worker` then runs `secrets`, which stops if `AWSBRIDGE_ACCESS_TEAM_DOMAIN` or `AWSBRIDGE_ACCESS_AUD` is empty; until the Access application exists in step 4, put a temporary value (for example `pending`) in `AWSBRIDGE_ACCESS_AUD`. `/mcp` returns 401 until you replace it.
2. AWS side: `AWS_PROFILE=<target> mise run deploy:aws` (note the outputs `ReadOnlyRoleArn` / `DebugRoleArn`)
3. Register the profile list. Write the role ARNs from the outputs into `config/profiles.json` (see "Multi-account") and run `mise run deploy:worker`. The list is a JSON file bundled into the Worker, not an environment variable, so the build fails without `config/profiles.json` (unset is an error)
4. Protect the connection host with Cloudflare Access (see `infra/cloudflare`): the application goes on `awsbridge-mcp.example.com` only, and `/.well-known/openid-configuration` and `/.well-known/jwks.json` on `awsbridge-oidc-mcp.example.com` stay public. Put the application's AUD in `AWSBRIDGE_ACCESS_AUD` and run `mise run secrets`. Then check that `/mcp` on `awsbridge-oidc-mcp.example.com` returns 401 and that workers.dev and Preview URLs do not answer.

```
mise run keygen                                               # Generate the signing key (.secrets/, not overwritten if it exists)
# Set AWSBRIDGE_ISSUER / AWSBRIDGE_ACCESS_* and others in mise.local.toml
cp config/profiles.example.json config/profiles.json          # The profile list (gitignored). Write the role ARNs
AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy mise run deploy:worker  # First time: wrangler deploy → secrets (does not call AWS)
mise run deploy:worker                                        # From then on: versions upload → versions deploy → secrets
```

From the second time on, deploy only the side you changed.

### AWS side (per target account)

Just deploy [infra/aws/awsbridge.yaml](infra/aws/awsbridge.yaml). It creates an IAM OIDC provider whose issuer is the Worker's issuer URL, and two roles that are assumed with the JWT issued by the Worker (read-only `FederatedAwsBridgeMcpViewer` and debug `FederatedAwsBridgeMcpDebugger`). These MCP roles are separate from the human console roles (Viewer / Administrator); granting a person a console role does not change what the MCP roles can do. Everyone can use the Viewer (`FederatedAwsBridgeMcpViewer`). Who gets the Debugger (`FederatedAwsBridgeMcpDebugger`) is decided by the downstream configuration (`DebugAllowedSubjects`); there is no upstream rule. Note when granting it: through remote shells and similar actions, the Debugger gets the permissions of the target's role, which carry no MCP-only condition.

```
AWS_PROFILE=<target> mise run deploy:aws    # Deploy CloudFormation (can be deployed to any number of accounts)
AWS_PROFILE=<target> mise run destroy:aws   # Clean up: delete the stack
```

A caller-supplied `AWS_PROFILE` takes precedence (`awsbridge` if unset). `AWSBRIDGE_STACK_NAME` / `AWSBRIDGE_AUDIENCE` can also be overridden with environment variables in the same way (their defaults live in `scripts/` and are not placed in `[env]` of `mise.toml`). On the other hand, values written in `mise.local.toml` or in a downstream repository's `mise.<name>.toml` take precedence over the caller's environment variables. If you want to switch the target account with `AWS_PROFILE=<target>`, do not write `AWS_PROFILE` in those files.

```
mise exec -- env AWS_PROFILE=<target> AWSBRIDGE_ALLOWED_SUBJECTS="user@example.com" AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS="admin@example.com" bash scripts/deploy-aws.sh
```

You can also deploy the template directly from the management console or with StackSets. The parameters in that case:

| Parameter | Description |
|---|---|
| `IssuerHost` | The host of the OIDC issuer, that is, of `AWSBRIDGE_ISSUER` (without `https://` and without a trailing `/`. Example: `awsbridge-oidc-mcp.example.com`; for a workers.dev trial, `awsbridge-dev.example.workers.dev`) |
| `Audience` | The JWT audience (default `awsbridge`. Must match the Worker's `STS_AUDIENCE`) |
| `AllowedSubjects` | Users who can assume the read-only role (comma-separated. See the format below. Specify in lowercase) |
| `DebugAllowedSubjects` | Users who can assume the debug role (same format. Keeping it narrower than the read-only role is recommended) |
| `ReadOnlyRoleName` | Read-only role name (default `FederatedAwsBridgeMcpViewer`) |
| `DebugRoleName` | Debug role name (default `FederatedAwsBridgeMcpDebugger`) |
| `DebugAdditionalPolicyArns` | Optional. Additional managed policies to attach to the debug role (comma-separated. Nothing is attached if empty) |
| `DebugPassableEcsTaskRoleArns` | Optional. IAM role ARNs that may be passed to a task with `ecs:RunTask` (comma-separated. Wildcards are not allowed). If empty, `iam:PassRole` is not granted |
| `DebugPassableBedrockServiceRoleArns` | Optional. IAM role ARNs that may be passed to a Bedrock evaluation job or batch inference job with `bedrock:CreateEvaluationJob` / `CreateModelInvocationJob` (comma-separated. Wildcards are not allowed). If empty, `iam:PassRole` for Bedrock is not granted. List only roles dedicated to those jobs |

After deployment, note the outputs `ReadOnlyRoleArn` / `DebugRoleArn` (you can also get them with `aws cloudformation describe-stacks`).

#### Role permissions and caveats

| Role | Permissions |
|---|---|
| `FederatedAwsBridgeMcpViewer` | The AWS managed policy `ReadOnlyAccess` + an explicit Deny (unconditional) on retrieving SSM parameters (`ssm:GetParameter` / `GetParameters` / `GetParametersByPath` / `GetParameterHistory`) and Secrets Manager values (`secretsmanager:GetSecretValue` / `BatchGetSecretValue`) |
| `FederatedAwsBridgeMcpDebugger` | `ReadOnlyAccess` + an inline policy (enhanced read access for investigation, light operational actions, actions that incur cost, and connection and execution; every Allow is conditional on `aws:CalledViaAWSMCP = aws-mcp.amazonaws.com`; includes the same unconditional Deny on retrieving SSM parameters and Secrets Manager values) + the optional `DebugAdditionalPolicyArns` |

The debug role's inline policy is divided into the following groups (every Allow is conditional on `aws:CalledViaAWSMCP = aws-mcp.amazonaws.com`, with Resource `*`). It does not include delete actions, IAM changes, or organization changes (a Knowledge Bases sync can still remove indexed documents as a result; see `Operations`).

| Group (Sid) | Contents |
|---|---|
| `Investigation` | Reads for investigation that go deeper than `ReadOnlyAccess`. Logs Insights / log retrieval / Live Tail, X-Ray, CloudTrail (`LookupEvents` and queries), running Athena queries, EC2 console output / screenshots, AWS Config `SelectResourceConfig` / `GetResourceConfigHistory` |
| `DenySsmParameterRead` / `DenySecretsManagerRead` | **Deny** (no condition, the same as the read-only role): `ssm:GetParameter` / `GetParameters` / `GetParametersByPath` / `GetParameterHistory`, `secretsmanager:GetSecretValue` / `BatchGetSecretValue`. It applies to direct calls and to calls through AWS MCP alike, and also overrides any Allow in managed policies added with `DebugAdditionalPolicyArns`. `kms:Decrypt` is not granted (see the notes below) |
| `Operations` | Light operational actions with side effects (no delete APIs): ECS `UpdateService` / `StopTask`, starting, stopping, and rebooting EC2, changing Lambda concurrency, changing Auto Scaling capacity, rebooting RDS / ElastiCache, CloudFront `CreateInvalidation`, starting and stopping a Bedrock Knowledge Bases sync (`bedrock:StartIngestionJob` / `StopIngestionJob`). A sync is not a delete action, but documents removed from the data source (such as S3) are also removed from the vector store.<br>Stop, restart, and fail over: `states:StopExecution`, `glue:BatchStopJobRun` / `StopCrawler`, `codebuild:RetryBuild` / `StopBuild`, `autoscaling:SuspendProcesses` / `ResumeProcesses`, `rds:FailoverDBCluster` / `RebootDBCluster`, `elasticache:TestFailover`, `elasticbeanstalk:RestartAppServer`.<br>Stop or suppress: `cloudwatch:DisableAlarmActions` / `EnableAlarmActions`, `events:EnableRule` / `DisableRule` / `CancelReplay`, `autoscaling:SetInstanceHealth` / `EnterStandby` / `ExitStandby`, `rds:StartDBInstance` / `StopDBInstance` / `StartDBCluster` / `StopDBCluster`, `ssm:StopAutomationExecution`, `batch:CancelJob`, `codepipeline:StopPipelineExecution` |
| `CostIncurring` | Actions that **incur cost**: `bedrock:InvokeModel` / `InvokeModelWithResponseStream` (including Converse) / `ApplyGuardrail` / `RetrieveAndGenerate`, `sagemaker:InvokeEndpoint` / `InvokeEndpointAsync`, `rds:CreateDBSnapshot` / `CreateDBClusterSnapshot`, `ec2:CreateSnapshot`, `lambda:PutProvisionedConcurrencyConfig`. Bedrock evaluation, batch inference, and prompt optimization: `bedrock:OptimizePrompt`, `CreateEvaluationJob` / `StopEvaluationJob`, `CreateModelInvocationJob` / `StopModelInvocationJob`, `CreateAdvancedPromptOptimizationJob` / `StopAdvancedPromptOptimizationJob`. Transcribe: `transcribe:StartTranscriptionJob`. Permissions to share snapshots are not included |
| `Execution` | Connection and execution: `ssm:SendCommand` / `StartSession` and others, EC2 Instance Connect, `ecs:ExecuteCommand` / `RunTask`, `lambda:InvokeFunction`, `states:StartExecution`, `sqs:SendMessage`, `sns:Publish`, `rds-db:connect`. Running business logic and deployments: `states:RedriveExecution` / `StartSyncExecution`, `bedrock:InvokeAgent`, `lambda:InvokeFunctionUrl`, `glue:StartCrawler` / `StartWorkflowRun`, `ssm:StartAutomationExecution`, `events:StartReplay` / `PutEvents`, `codepipeline:RetryStageExecution`. `iam:PassRole` for `ecs:RunTask` is a separate Statement, granted only when `DebugPassableEcsTaskRoleArns` is specified; it limits the roles that can be passed to those ARNs and the recipient to `ecs-tasks.amazonaws.com` (if empty, only task definitions without a task role can be run) |
| `PassRoleForBedrockJobs` | `iam:PassRole` for `bedrock:CreateEvaluationJob` / `CreateModelInvocationJob`. A separate Statement, granted only when `DebugPassableBedrockServiceRoleArns` is specified; it limits the roles that can be passed to those ARNs and the recipient to `bedrock.amazonaws.com` (conditional on `aws:CalledViaAWSMCP` as well). Batch inference passes the roles listed in `DebugPassableBedrockServiceRoleArns`, just like evaluation jobs. `DataAccessRoleArn` of Transcribe (the form that passes a role) has no `iam:PassRole` to `transcribe.amazonaws.com`, so it cannot be used |

Athena queries also need a separate write permission (`s3:PutObject`) to the result bucket. This policy does not include it, so add it with `DebugAdditionalPolicyArns` if needed.

The Knowledge Bases sync actions (`bedrock:StartIngestionJob` / `StopIngestionJob`) also use Resource `*`, like the other groups. The debug role is meant to investigate any resource in the account, and the other actions (ECS, EC2, RDS, and so on) do not take target ARNs as parameters either, so there is no parameter to narrow them to Knowledge Base ARNs (`DebugAdditionalPolicyArns` only adds permissions and cannot narrow them). To narrow them, edit the `Operations` Resource in the template to `arn:${Partition}:bedrock:${Region}:${Account}:knowledge-base/${KnowledgeBaseId}`, or add an `aws:ResourceTag` condition.

- **The debug role includes permissions equivalent to remote execution.** `ssm:SendCommand` / `ssm:StartSession` / `ecs:ExecuteCommand` are equivalent to a remote shell, and secrets, credentials, and file contents may become visible (commands run with the instance or task role's permissions, which may be able to read secret values). `Operations`, as well as `lambda:InvokeFunction`, `states:StartExecution`, `sqs:SendMessage`, and `sns:Publish`, run processes with side effects.
- **The debug role includes actions that incur cost or run deployments.** Model and inference endpoint invocations, snapshot creation, and provisioned concurrency in `CostIncurring` are billed (`rds:StopDBInstance` can also create a snapshot). `codepipeline:RetryStageExecution` retries a failed stage and may run a production deployment. `events:StartReplay` / `PutEvents`, `bedrock:InvokeAgent`, `glue:StartCrawler` / `StartWorkflowRun`, and `ssm:StartAutomationExecution` run their targets, jobs, or automations. Depending on its settings, `glue:StartCrawler` deletes or deprecates catalog tables.
- **Bedrock evaluation jobs, batch inference, Advanced Prompt Optimization, and Transcribe jobs keep running after the session ends and are billed.** `bedrock:CreateEvaluationJob`, `CreateModelInvocationJob`, `CreateAdvancedPromptOptimizationJob`, and `transcribe:StartTranscriptionJob` start jobs that do not stop when the session is closed. Stopping them needs `bedrock:StopEvaluationJob` / `StopModelInvocationJob` / `StopAdvancedPromptOptimizationJob` (all granted). These Stop actions use Resource `*`, so they can also stop jobs that other people started, not only the jobs this session created; stopping a job does not refund the cost already incurred. Transcribe has no stop operation (only `DeleteTranscriptionJob`, which is not granted), so a started transcription job cannot be stopped from here. What can be passed to a Bedrock job is decided by "the roles listed in `DebugPassableBedrockServiceRoleArns` x the Create operations allowed here (`CreateEvaluationJob`, `CreateModelInvocationJob`)", and it is decided by the role's effective permissions, including what you add with `DebugAdditionalPolicyArns` and any Bedrock operation added in the future. Evaluation jobs and batch inference run with the permissions of the service role you pass, so through that role they can read data the debug role cannot read directly and write to any output location the role allows; the debug role's Deny on secret reads is not inherited by the service role. Make every listed role dedicated to those jobs and least-privilege (limit the input and output prefixes, the models, and KMS), and do not list an existing role with broad permissions. In the trust policy, use `aws:SourceAccount` and, where supported, `aws:SourceArn` as well (confirm that the key is provided for that job type). `aws:SourceAccount` only counters the confused deputy; it does not narrow what the service role itself can do, which must be limited separately.
- **Remember to undo stop and suppress actions.** Leaving `cloudwatch:DisableAlarmActions`, `events:DisableRule`, or `autoscaling:SuspendProcesses` / `EnterStandby` in place can hide incidents or stop self-healing. An instance marked Unhealthy with `autoscaling:SetInstanceHealth` is terminated and replaced.
- **The values in Secrets Manager and SSM Parameter Store cannot be read directly through the API (both roles).** Both roles deny `ssm:GetParameter` / `GetParameters` / `GetParametersByPath` / `GetParameterHistory` and `secretsmanager:GetSecretValue` / `BatchGetSecretValue` with no condition, so the Deny applies whether or not the call goes through AWS MCP. `ReadOnlyAccess` (v191) includes `ssm:Get*` (SecureString values with the `aws/ssm` key are also decrypted through the key policy), so without the Deny the session could read SSM parameters. `ReadOnlyAccess` does not include `secretsmanager:GetSecretValue` or `kms:Decrypt`, and the inline policy grants neither. Because an explicit Deny always wins, adding a managed policy with `DebugAdditionalPolicyArns` cannot bring these reads back.
- **No S3 write permission is granted to the debug role itself (no `s3:PutObject`), and what that means for the jobs (all not measured yet).** This is about the debug role only; it does not limit the service role you pass (see the previous item). Evaluation jobs (`CreateEvaluationJob`) and batch inference (`CreateModelInvocationJob`) read and write S3 with the service role you pass, so this role needs no S3 write; the input data has to be put into S3 by other means (another role). Advanced Prompt Optimization uses the permissions of the calling identity (Forward Access Session) for S3 and models: the AWS documentation (https://docs.aws.amazon.com/bedrock/latest/userguide/advanced-prompt-optimization-prereqs.html) says "using the permissions of your calling identity" and that the caller needs read access to the input and write access to the output location. So it is expected to fail to write its output with this role alone (the actual behavior is not measured); if you add `s3:PutObject` with `DebugAdditionalPolicyArns`, note that an additional managed policy does not automatically get the inline policy's MCP condition: limit it to the output bucket and prefix, and add the `aws:CalledViaAWSMCP` condition yourself. The permissions it really needs are not measured and may include more than writing the output. A Transcribe job (`StartTranscriptionJob`) with `OutputBucketName` is expected to be the same (not measured): the Amazon Transcribe guide ("Permissions required for IAM roles") describes the IAM entity that makes the request needing `s3:PutObject` on the output bucket, but it does not state whose identity is used. Without `OutputBucketName`, the transcript goes to a service-managed bucket and no write permission is needed.
- **Remaining unmeasured items (not verified against a real environment):** (1) whether `aws:CalledViaAWSMCP` is attached to the downstream calls that Advanced Prompt Optimization and Transcribe make with the caller's own permissions (Forward Access Session); (2) behavior with global inference profiles; (3) creating a job that needs `iam:PassRole`.
- **Some privilege escalation paths are closed, but not all (the remote shells below remain).** Granting `iam:PassRole` on `*` would let tasks run with any role, so it is not granted by default and is limited to the roles explicitly listed in `DebugPassableEcsTaskRoleArns` (ECS) and `DebugPassableBedrockServiceRoleArns` (Bedrock evaluation and batch inference jobs). Also, `lambda:UpdateFunctionConfiguration` (swapping the execution role or environment variables) and `autoscaling:UpdateAutoScalingGroup` (swapping the launch template) are not granted. `glue:StartJobRun` and `batch:SubmitJob` are not granted: overriding job arguments or the command and environment variables can run arbitrary code with the job's role (the same reason as `codebuild:StartBuild`). `codepipeline:StartPipelineExecution` is not granted either: `sourceRevisions` can swap the source commit, S3 object, or image, and `variables` can pass arbitrary values into the pipeline (the same reason `codebuild:StartBuild`, which can override its arguments, is not granted; use `RetryStageExecution` to re-run). `iam:PassRole` for `ssm:StartAutomationExecution` is not granted, so automations run only within the caller's permissions.
- **Remaining risk:** `ssm:SendCommand` / `ssm:StartSession` / `ecs:ExecuteCommand` / EC2 Instance Connect can act with the permissions of the role attached to the target instance or task. If a highly privileged instance or task exists in the same account, those permissions can be borrowed. In production, narrow the targets with tag conditions or SSM documents.
- **This does not mean that the roles cannot read secrets.** Paths other than those two APIs remain: remote shells (debug role: `ssm:SendCommand` / `StartSession`, `ecs:ExecuteCommand`, EC2 Instance Connect act with the instance or task role's permissions, which may read secret values), the output of SSM commands (`ssm:GetCommandInvocation` / `ListCommandInvocations`) and Automation executions, Lambda environment variables and the code download URL returned by `lambda:GetFunction`, plaintext environment variables in ECS task definitions and CodeBuild projects, EC2 user data, CloudFormation templates and outputs, AppConfig configuration content, S3 objects (`s3:GetObject`), logs, and `rds-db:connect` (debug role). Secret references in ECS (`secrets` / `valueFrom`) and CodeBuild (`SECRETS_MANAGER` / `PARAMETER_STORE` type) show only where the value is, not the value itself, unlike plaintext environment variables. Many of these paths are used routinely in investigations and are not denied. If secret values are stored there, narrow `AllowedSubjects` / `DebugAllowedSubjects`, or add your own Deny with a permissions boundary or an SCP.
- **`ReadOnlyAccess` is not pinned to a version.** It is an AWS managed policy, so AWS updates can change what it can read. The Deny above names the value-retrieval APIs explicitly, so that part is not affected by such updates.
- **`ReadOnlyAccess` is not limited to calls through MCP.** IAM conditions cannot be attached to AWS managed policies, so the read permissions remain valid even if you call the API directly with the session credentials. Only the Allows in the debug role's inline policy are restricted by `aws:CalledViaAWSMCP`.
- In production, narrow `Resource` to specific ARNs, tags, or SSM documents, and always enable session logs (SSM Session Manager logs, ECS Exec logs, Lambda CloudWatch Logs). CloudTrail alone is not enough.
- Users are separated per role by `AllowedSubjects` (read-only) and `DebugAllowedSubjects` (debug). Keep `DebugAllowedSubjects` narrower than the read-only list.

### Variables in `mise.local.toml`

Fixed defaults are in `mise.toml`. Account-specific values go in `mise.local.toml` (gitignored). All values are placeholders.

```toml
[env]
AWSBRIDGE_ISSUER = "https://awsbridge-oidc-mcp.example.com"             # The OIDC issuer (a dedicated host on your domain; no path). Not the MCP connection host awsbridge-mcp.example.com
AWSBRIDGE_WRANGLER_ENV = "prod"                               # env.prod of wrangler.jsonc (Custom Domains). The default is dev (workers.dev, for a trial)
AWSBRIDGE_ALLOWED_SUBJECTS = "user@example.com,*@example.org" # Users who can assume the read-only role (comma-separated)
AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS = "admin@example.com"       # Users who can assume the debug role (comma-separated)
# AWSBRIDGE_READONLY_ROLE_NAME = "FederatedAwsBridgeMcpViewer"        # Optional. Role name (default value)
# AWSBRIDGE_DEBUG_ROLE_NAME = "FederatedAwsBridgeMcpDebugger"          # Optional. Role name (default value)
# AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS = "arn:aws:iam::<account-id>:policy/<name>" # Optional. Additional managed policies for the debug role (comma-separated)
# AWSBRIDGE_DEBUG_PASSABLE_ECS_TASK_ROLE_ARNS = "arn:aws:iam::<account-id>:role/<name>"     # Optional. DebugPassableEcsTaskRoleArns
# AWSBRIDGE_DEBUG_PASSABLE_BEDROCK_SERVICE_ROLE_ARNS = "arn:aws:iam::<account-id>:role/<name>" # Optional. DebugPassableBedrockServiceRoleArns
AWSBRIDGE_POC_SUBJECT = "user@example.com"                   # The user used in the positive case of poc:sts (verification only)
AWSBRIDGE_ACCESS_TEAM_DOMAIN = "https://team.example.cloudflareaccess.com" # The Access team domain
AWSBRIDGE_ACCESS_AUD = "<AUD tag of the Access application>"   # The AUD of this application
```

Format of `AWSBRIDGE_ALLOWED_SUBJECTS` and `AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS` (the same for both): each element takes the form `user@example.com` or `*@example.com`. A wildcard can be used only in the local part of the email; the domain part (`*@*` or `*@*.com`) and a bare `*` are not allowed (they would permit everyone). Empty elements and leading or trailing whitespace are also errors. Emails are normalized to lowercase before matching (the Worker lowercases the Access JWT's email before passing it to STS, and `deploy:aws` also lowercases these values before passing them to CloudFormation). `deploy:aws` validates this before calling AWS, and the CloudFormation template performs the same check with `AllowedPattern`.

The managed policies attached with `AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS` become exactly the operations that a user who assumes the debug role can perform. Attach only the minimum necessary permissions (nothing is attached if unset).

Overridable defaults (filled in on the `scripts/` side. Can be changed with environment variables, `mise.local.toml`, or a downstream mise config file): `AWS_PROFILE` (`awsbridge`), `AWSBRIDGE_AUDIENCE` (`awsbridge`), `AWSBRIDGE_STACK_NAME` (`awsbridge`), `AWSBRIDGE_KEY_FILE` (`.secrets/dev-signing-key.json` at the repository root), `AWSBRIDGE_NEXT_KEY_FILE` / `AWSBRIDGE_PREVIOUS_KEY_FILE` (for key rotation. By default, `.next` / `.previous` is added before the extension of `AWSBRIDGE_KEY_FILE`), `AWSBRIDGE_WRANGLER_CONFIG` (`wrangler.jsonc`), `AWSBRIDGE_WRANGLER_ENV` (`dev` if unset. **If it is an empty string, `--env` is not added**), `AWSBRIDGE_WRANGLER_DEPLOY_MODE` (`versions` if unset; `deploy` for the explicit route).

### Worker configuration

Secrets (registered by `mise run secrets`): `SIGNING_JWK`, `ADDITIONAL_PUBLIC_JWKS` (optional. Additional public keys for signing key rotation. Normally `[]`), `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`. `secrets` can also be run on its own. It passes JSON to `wrangler secret bulk` via standard input, so values do not appear in command-line arguments. The profile list is not a secret (a Workers environment variable is limited to 5 KB each, and 270 profiles take about 38 KB); it is passed as a bundled JSON module (`awsbridge:profiles`; required. See "Multi-account").

Vars (optional. Only when overriding the defaults): `ISSUER` (set with `--var` at deploy time), `IDENTITY_CLAIM` (default `email`), `ACCESS_MAX_TOKEN_AGE_SECONDS`, `STS_AUDIENCE` (default `awsbridge`), `STS_REGION` (default `us-east-1`), `STS_ENDPOINT`, `AWS_MCP_REGION` (default `us-east-1`), `AWS_MCP_ENDPOINT`, `TARGET_AWS_REGION` (default `ap-northeast-1`), `ALLOWED_ORIGINS` (comma-separated exact-match origins. Empty by default).

As a CSRF countermeasure, `/mcp` rejects requests that carry an `Origin` header (that is, requests from a browser) with 403 `forbidden_origin` unless the origin is included in `ALLOWED_ORIGINS`. Server-to-server traffic from MCP clients and the Portal, which have no `Origin`, passes through. A POST is accepted only when `Content-Type` is `application/json` (parameters such as `; charset=utf-8` are allowed); anything else (including a missing Content-Type) results in 415 `unsupported_media_type`. Access verifies the browser's cookie and injects `Cf-Access-Jwt-Assertion`, so authentication alone cannot prevent CSRF.

Errors from `/mcp` are returned as `{"error":"<code>"}`: `unauthorized` (401), `forbidden` (403. No permission to assume the role), `upstream_auth_failed` (502. Server-side configuration inconsistency), `temporarily_unavailable` (503), `server_misconfigured` (500), `unknown_aws_profile` / `invalid_aws_profile` / `batch_not_supported` (400). For a table of responses by cause, see the section on the error to HTTP status mapping in `docs/specs/architecture.md`.

### Multi-account

You can switch between multiple AWS accounts with the `aws_profile` argument of MCP `tools/call`. The Worker directly assumes the selected account's role with AssumeRoleWithWebIdentity (no chaining). Who can use which account is determined by each account's trust policy (`AllowedSubjects` / `DebugAllowedSubjects`), and anything not permitted results in 403 `forbidden`.

1. For each target account, run `AWS_PROFILE=<target> mise run deploy:aws` and note the outputs `ReadOnlyRoleArn` / `DebugRoleArn`.
2. Write the profile list (required) in a JSON file. For the upstream's own development deployment, create it with `cp config/profiles.example.json config/profiles.json` (gitignored; values are placeholders). The list is not an environment variable: wrangler's `alias` bundles it into the Worker as the JSON module `awsbridge:profiles`, so there is practically no limit on the number of profiles (a Workers environment variable is limited to 5 KB each). Without the file, the build (`wrangler deploy` / `wrangler dev`) fails with `Cannot find module`. Writing `profiles` as an array is recommended. The order of the array becomes the order of the list returned by `list_aws_profiles` as-is (`default` is always first).

```json
{
  "default": "dev-readonly",
  "profiles": [
    { "name": "dev-readonly",  "roleArn": "arn:aws:iam::111111111111:role/FederatedAwsBridgeMcpViewer", "description": "development (read-only)" },
    { "name": "dev-debug",     "roleArn": "arn:aws:iam::111111111111:role/FederatedAwsBridgeMcpDebugger", "description": "development (debug)" },
    { "name": "prod-readonly", "roleArn": "arn:aws:iam::222222222222:role/FederatedAwsBridgeMcpViewer" },
    { "name": "prod-debug",    "roleArn": "arn:aws:iam::222222222222:role/FederatedAwsBridgeMcpDebugger" }
  ]
}
```

`profiles` can also be written as an object (`"profiles": { "dev-readonly": { "roleArn": "..." }, ... }`; the legacy format). However, the order of object keys is sometimes not preserved along the path to the Worker (the cause is unidentified. In a real environment, there was a case where `dev-readonly` → `dev-debug` was written but the Portal's enum ended up in name order). If you intend a particular order, write it as an array. In the array format, `name` is required, and duplicates result in 500 `server_misconfigured`.

- Profile names: 1 to 32 characters of alphanumerics, `_`, and `-` (exceeding that results in 500 `server_misconfigured`). Names consisting only of digits are ordered first in numeric order by the rules for objects, so avoid them if you intend a particular order.
- `default`: required. The profile used when `aws_profile` is omitted, and for requests other than `tools/call` such as `tools/list`.
- `tools`: optional. The tools that `aws_profile` applies to (all tools if omitted; omitting is normally fine). The names are the actual tool names returned by the AWS MCP Server (for example `aws___run_script`; you can check them with `tools/list`), and if you write a name that does not exist, `aws_profile` has no effect. An `aws_profile` attached to a tool that is not a target is ignored and removed.
- In the `tools/list` response, `inputSchema.properties.aws_profile` (`{type: "string", description}`; no `enum`, and the description contains neither the default nor any profile name) is injected into the target tools, and a `list_aws_profiles` tool is added (not on the second and later pages of a paginated `tools/list`). Clients (such as Claude) get the available profiles at run time by calling `list_aws_profiles`, which the Worker answers by itself after authentication (it returns `{default, profiles: [{name, description?}]}`, never a `roleArn`). Because the injected schema does not depend on the profile list, adding a profile needs neither a re-sync of the MCP Portal nor a reconnection of claude.ai. A re-sync and reconnection are needed only when the upstream tool set changes or when an awsbridge update changes the injected schema (including the first time you take in the update that removed the `enum` and added `list_aws_profiles`). Tools whose upstream definition already has `aws_profile` are not injected. If the response cannot be processed, it is returned as is.
- `aws_profile` is removed before being sent upstream. For a single `tools/call`, a name not in the list (`unknown_aws_profile`) or a non-string (`invalid_aws_profile`) is returned as HTTP 200 with a JSON-RPC result `isError: true` whose text contains the error code, the available profile names, and the default, so the client can correct it in one try. In a JSON-RPC batch, it results in 400 with `{"error": "<code>"}`.
- For a JSON-RPC batch, if the `aws_profile` of all target tools is the same (omitted means `default`), it is relayed with that role; if they differ, it results in 400 `batch_not_supported`.
- If the list is invalid (a format error, a duplicate, empty, and so on), the result is 500 `server_misconfigured` (the log shows only `config: invalid profiles: <kind>`, never the values). Unset makes the build fail.
- The STS `RoleSessionName` is `gw-<user>-<profile name>` (so you can tell them apart in CloudTrail).

A downstream repository does not edit the upstream `wrangler.jsonc`; its own `wrangler.<name>.jsonc` points `alias` at its own JSON (for example `deploy/profiles.json`) (see "Operating in a downstream repository"). For details, see the section on multi-account (aws_profile) in `docs/specs/architecture.md`.

## Console login setup

For production, follow the order of the steps, the checks with their expected results, and the checklist before adding an Administrator in [Rolling out console login in production](docs/console-production-rollout.md).

### Order of the first setup (console login)

Each step is described in the sections below. A person runs the key and CSRF key tools from a local machine, never from CI. **Only people allowed to issue Administrator deploy the console Worker and operate its keys, from the first deployment on** (acceptance b), even while only Viewer is configured.

1. **Config**: write the console config and check it with `mise run console:config:check` ("Config file and generated files"). For the first setup, leave out the teams of the Admin tier and the Administrator role.
2. **Access**: create the entry application and the team applications with Cookie Path enabled and save their AUDs ("Access applications for console login (Cookie Path)").
3. **Generate**: `mise run console:config:generate -- --ledger-init` the first time (there is no ledger to compare with yet; see "Ledger of retired team names"), plain `mise run console:config:generate` afterwards. It needs the AUDs of the teams, and the entry AUD only when there are two or more Standard teams. Then check the Access applications with `mise run console:access:inspect`, which reads the generated `access.json`. Before the first deployment, run `mise run console:inspect -- --profile=<p>` in each target account (required after `--ledger-init`): in an account that has no console role or provider yet, the only expected errors are `role_missing` and `provider_missing`; a `trust_team_retired`, `trust_team_tier`, or `unlisted_role` stops the setup until it is explained.
4. **Worker**: deploy it, upload the signing key of each boundary and the CSRF key, write the key vars, deploy again, and run `mise run console:key:check` ("Console login signing keys"). The issuer is published only after this step.
5. **Base stack** in each target account, after the issuer is published: IAM reads the issuer's discovery document when it creates the OIDC provider. This order is inferred from the same mechanism as for the earlier per-tier Admin issuer; it has not been measured with the single issuer ("Required stack for console login (base)").
6. **Role stacks** from the generated `kind.<kind>.yaml` ("Role stacks").
7. **Check**: `mise run console:inspect -- --profile=<p>` in each account (0 errors) and `mise run console:exposure-check`, then start the daily checks ("Daily operations").
8. **Admin tier** (only if you deploy an Administrator, and in production only after the steps of the rollout document): follow "Adding the Admin tier and the Administrator role".

### Config file and generated files

Which teams exist, which roles there are, and which team may enter which role in which kind of account are set in one config file. The upstream holds only the schema (`src/console/config.ts`), the examples, and the tools; the real values live downstream (`docs/specs/console-login-portal.md` §11).

- Examples: [`config/console.example.json`](config/console.example.json) (a personal minimum: one team, a Viewer, one account) and [`config/console.company.example.json`](config/console.company.example.json) (a company shape with an Admin tier). Copy one to `config/console.json` (upstream development; gitignored) or to your downstream file (for example `deploy/console.json`, given with `AWSBRIDGE_CONSOLE_CONFIG`).
- Inputs (environment variables; defaults filled in by `scripts/console/config.ts`): `AWSBRIDGE_CONSOLE_CONFIG` (default `config/console.json`), `AWSBRIDGE_CONSOLE_AUD_FILE` (the Terraform output `{ "teams": { <team>: <AUD> }, "entry": <AUD> }`; optional, and a personal setup without Terraform can write `access.aud` in the config instead), `AWSBRIDGE_CONSOLE_INVENTORY_FILE` (the accounts of an Organization for `placement: ou`; optional; it contains emails, so do not commit it), `AWSBRIDGE_CONSOLE_OUT_DIR` (default `.generated/console`; gitignored), `AWSBRIDGE_CONSOLE_SOURCE_REVISION` (optional; the commit recorded in the generated files).
- Neither task calls AWS, Cloudflare, or Terraform. Errors in the config stop the generation (the output shows the key path and the kind of error, never the values).

| Generated file | Used by |
|---|---|
| `worker.json` | The console Worker (`alias`): the AUDs and tiers of the teams of both tiers, role ARNs, the boundary issuers |
| `display.json` | The console Worker (`alias`): the entry list only. The Administrator rows are for display and carry no email, AUD, or ARN |
| `stacksets.json` | The parameters of the base stack (`providers`) and of the role stacks per kind, and the ledger of retired team names |
| `access.json` | `mise run console:access:inspect` and comparison with Terraform in CI |
| `kind.<kind>.yaml` | The role template of each kind (reference shape; see "Role stacks") |

```bash
cp config/console.example.json config/console.json   # upstream development; downstream: your own file and AWSBRIDGE_CONSOLE_CONFIG
mise run console:config:check      # schema, references, duplicates, tiers (and the AUD mapping when AWSBRIDGE_CONSOLE_AUD_FILE is given); writes nothing
mise run console:config:generate   # writes the generated files to AWSBRIDGE_CONSOLE_OUT_DIR (the first time: -- --ledger-init)
```

#### Ledger of retired team names

- It compares with the previous artifacts in the output directory (`stacksets.json`) and, when given, with `--ledger-baseline <path>` (a `stacksets.json` you kept). With both, it must pass both. A baseline that cannot be read or has the wrong shape is an error.
- Generating with no ledger to compare with (no previous artifacts and no baseline, or previous artifacts in the shape from before the console moved to one Worker, issuer, and provider) is an error. Only the first generation and the migration from that earlier shape pass, with `mise run console:config:generate -- --ledger-init` (the first-run flag). Passing it while the previous artifacts or the baseline have a ledger is an error. It is recorded on standard output and in the meta of `stacksets.json` (`ledgerInit`; gone after the next generation).
- After using `--ledger-init`, run `mise run console:inspect` before you deploy (to see that no old or retired team name is left in a trust policy).
- Keep the previous artifacts (`.generated/console/stacksets.json`) or a baseline (the artifacts are gitignored; in a new checkout, pass it with `--ledger-baseline <path>`).
- `mise run console:config:check` is unchanged: without previous artifacts it says nothing, and with them it compares.

### Access applications for console login (Cookie Path)

The console-login portal (the entry screen) sits behind Cloudflare Access applications: an entry application for the portal host and one application per team at `<host>/t/<team>`. When teams are separated by path (`portal.routing: path`, the default), **Cookie Path (`path_cookie_attribute`) must be enabled on the entry application and on every team application** (the teams of the Standard and the Admin tier sit on the same host under `/t/<team>`). If it is disabled, the AUD of another application on the same host also lands in the `aud` of the Access JWT, and the Worker's "exactly one `aud`" check rejects it (nobody can log in). When teams are separated by host (`routing: host`), cookies are already separated by host, so this is only a warning. The Worker does not enforce Cookie Path; it is checked in two ways.

- Reference Terraform: [`infra/cloudflare/console/`](infra/cloudflare/console/) (a separate state from the MCP-side `infra/cloudflare/`). It creates the entry application (one) and the team applications (`for_each`) and pins `path_cookie_attribute = true` (not a variable). The applications of teams of the Admin tier get a short session (`admin_session_duration`, default 15 minutes). It is an example that has not been applied. Save `terraform output -json console_aud` as `AWSBRIDGE_CONSOLE_AUD_FILE`.
- Inspection: `mise run console:access:inspect`. Run `mise run console:config:generate` first to write `access.json`; the tool reads the Cloudflare API (GET only, no writes) and checks that an application exists for each entry and team AUD, that its type is `self_hosted`, that its destination is `<host>/t/<team>`, and that Cookie Path is enabled. With R-P a disabled (false or missing) Cookie Path is an error (exit code 1), and an application under `/t/` that is not in the config is a warning. The output never contains an AUD, a token, or an account ID.
- Give it a dedicated read-only token (Access: Apps and Policies Read only) in `AWSBRIDGE_CONSOLE_ACCESS_READ_TOKEN` and the account ID in `AWSBRIDGE_CONSOLE_ACCESS_CF_ACCOUNT_ID`, both in `mise.local.toml`. It does not fall back to the `wrangler login` OAuth and does not read the other tools' tokens.
- What 0 errors does not cover: who the policies of an application allow (include, require, and exclude rules), the session duration, and other applications, Allow policies, or Bypass rules that cover the same paths. A misconfigured Admin-tier application lets people through with a valid Admin-tier AUD, which the Worker cannot refuse. A person reviews the policies and the session settings of the Admin-tier applications and records them.
- Do not create an Access application on the issuer host: IAM and STS fetch it without authentication.

### Console login signing keys

The console-login Worker (`wrangler.console.jsonc`; one Worker that issues both Viewer and Administrator) signs the JWT it passes to STS with a Workers binding of type `secret_key` (a non-extractable `CryptoKey`; RSASSA-PKCS1-v1_5 / SHA-256, usages `sign` only), one per boundary (`managed`, `partner:<id>`). A boundary's key is used for both Viewer and Administrator (acceptance a). A private JWK stored as a string secret is not used.

- `mise run console:key:put -- --boundary <boundary>` creates the key in its own memory and uploads it with the Cloudflare API. It does not write the key to a file or print it, and the key never passes through CI or logs. A person runs it, only from a local machine. wrangler has no command to upload a `secret_key`.
- The binding name is `CONSOLE_KEY_<first 8 bytes of the kid in hex>`, derived from the kid (the boundary name is not part of it). The tool refuses an existing name. A new key always gets a different name.
- The Worker reads the vars `CONSOLE_CURRENT_KEYS` (boundary -> name and kid of the current key) and `CONSOLE_PUBLIC_JWKS` (boundary -> public keys, at most old and new). If either is empty or broken, if a current kid is missing from its boundary's public keys, or if one key appears in two boundaries, every route returns `500 server_misconfigured`. Before signing it checks the boundary's binding (a `CryptoKey`, non-extractable, `sign` only, `exportKey` fails), checks that the tier of the team in the tag matches the tier of the role ARN's path, and verifies each signed JWT with the public key in the vars. If anything does not match, issuing for that boundary returns `503 signing_unavailable`. Each boundary's issuer JWKS serves only that boundary's public keys from the vars.
- Until the keys are uploaded (while the vars are empty), every route returns `500`. For the first setup, deploy the Worker, upload the keys and the CSRF key, then set the vars and deploy again.
- The CSRF key `CONSOLE_CSRF_KEY` stays a `secret_text`. `mise run console:secrets -- --yes` creates 32 random bytes locally and uploads them (no file, not printed). After recreating it, open forms need to be reloaded.
- Tokens: for `AWSBRIDGE_CONSOLE_CF_API_TOKEN`, use a token that can write only the console Worker (no zone permissions) (without it, the `wrangler login` OAuth token is used, in memory only). **Only people allowed to issue Administrator deploy the Worker and operate the keys** (acceptance b). Even though the key cannot be extracted, anyone who can change the Worker's code or secrets can sign any JWT.
- Stopping: setting the var `LOGIN_DISABLED` to `true` stops new issuance for everything; setting `ADMIN_LOGIN_DISABLED` to `true` stops it only for teams of the Admin tier (both fail closed: any value other than `false`, `0`, empty, or unset stops). Sessions already issued are not stopped (revoke). The age limit of the Access JWT for teams of the Admin tier is the var `ADMIN_ACCESS_MAX_AGE_SECONDS` (seconds, 60 to 86400, default `900`).
- Update paths: in a development account we confirmed that a `secret_key` binding survives `wrangler deploy`, `wrangler secret put` / `wrangler secret bulk` / `wrangler secret delete` on other secrets, and `wrangler versions secret put / bulk` followed by `versions deploy` (measured with a test Worker in a development account). Managing the Worker's bindings from the dashboard or Terraform was not measured, so do not use those paths.
- Variables (`mise.local.toml`): `AWSBRIDGE_CONSOLE_CF_ACCOUNT_ID` (or `account_id` in the wrangler config), `AWSBRIDGE_CONSOLE_CF_API_TOKEN` (optional), `AWSBRIDGE_CONSOLE_WRANGLER_CONFIG` (default `wrangler.console.jsonc`), `AWSBRIDGE_CONSOLE_ACCESS_TOKEN` (optional; the Access token used for the key-check in `check`; with `--team <team>` it also opens on the path of a team of the Admin tier).
- Other vars of the Worker: `ACCESS_TEAM_DOMAIN`, `STS_REGION` (CloudTrail records `AssumeRoleWithWebIdentity` in this region). Issue records go to Workers Logs, and the wrangler config pins `observability.head_sampling_rate` to `1`.

Checking the bundle, running locally, and deploying (run `mise run console:config:generate` first. The wrangler config is `AWSBRIDGE_CONSOLE_WRANGLER_CONFIG`, default `wrangler.console.jsonc`; the MCP-side `AWSBRIDGE_WRANGLER_CONFIG` / `AWSBRIDGE_WRANGLER_ENV` are not read by these tasks):

```bash
mise run console:build   # wrangler deploy --dry-run --outdir dist/console (bundles even while the key vars are empty)
mise run console:dev     # wrangler dev (local use; a secret_key binding cannot be created locally, so every route returns 500 while the key vars are empty)
# Deploy by hand after you approve it (check the routes and vars first). The first time and when a Custom Domain changes, use the explicit route:
#   e.g. AWSBRIDGE_WRANGLER_CONFIG=wrangler.console.jsonc AWSBRIDGE_WRANGLER_ENV= AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy bash scripts/wrangler.sh deploy
# Later deploys (for example after changing the vars) take the default route: leave out AWSBRIDGE_WRANGLER_DEPLOY_MODE
# (that the key binding survives versions upload was measured once on the earlier per-tier Admin Worker; the record is in docs/specs/console-login-admin.md;
#  for the single console Worker it is inferred from the same mechanism, so run mise run console:key:check after the deploy)
```

First upload (per boundary):


```bash
mise run console:key:put -- --boundary managed            # only shows what it would do (no API calls)
mise run console:key:put -- --boundary managed --yes      # creates the key and uploads it as a secret_key; prints the name, kid, public key, and the vars to set next
# put reads the vars in the wrangler config and prints them with only this boundary replaced.
# Before moving to the next boundary, write the printed CONSOLE_PUBLIC_JWKS and CONSOLE_CURRENT_KEYS into the vars of the wrangler config
mise run console:key:put -- --boundary partner:partner-x --yes
# again, write the printed vars into the wrangler config
mise run console:secrets -- --yes                         # the CSRF key (secret_text)
# once the vars cover every boundary, deploy
mise run console:key:check     # per boundary: binding type, discovery and JWKS, key-check (non-extractable, exportKey fails, self-verification)
```

Rotation is in "Key rotation" under "Daily operations".

### Required stack for console login (base)

[`infra/aws/console/base.yaml`](infra/aws/console/base.yaml) (StackSet `awsbridge-console-base`) creates the IAM OIDC provider for console login (one, shared by Viewer and Administrator) and the per-tier guard policies (customer managed, explicit Denies only). It does not create roles (the reference role template is [`infra/aws/console/kind.example.yaml`](infra/aws/console/kind.example.yaml); regenerate it with `mise run console:template:example` after changing the generator). Design: `docs/specs/console-login.md` §4.2 and §4.8. The parameters per account are in the generated `stacksets.json` (`providers`).

| Parameter | Default | Meaning |
|---|---|---|
| `IssuerHost` | none (required) | Host of the issuer (e.g. `awsbridge-oidc-console.example.com`) |
| `IssuerPath` | `console` | Path of the issuer. Issuer = `https://<IssuerHost>/<IssuerPath>` (`p/<id>/console` for a partner) |
| `Audience` | `awsbridge-console` | Fixed |

- There is one provider per boundary, and the roles of both the Standard and the Admin tier trust the same provider. The only thing that separates Viewer from Administrator is the team condition (`aws:RequestTag/awsbridge_team`) in the role trust policy (acceptance d).
- The Admin guard policy (`AwsbridgeConsoleGuardAdmin`, including the Deny of `aws login --remote`) and its export are always created in every account. Whether Administrator is deployed is decided only by whether the Administrator role stack (a separate stack) is created.
- Both guard policies deny writes to the console provider (every path under `<IssuerHost>`): create, delete, adding a client ID, and so on. The Deny statement with a single host has not been measured on real AWS yet (unverified; to be measured in the downstream production rollout). The inspection tool (`mise run console:inspect`) expects guard policies of this shape (otherwise `guard_version_mismatch`).
- **Always run `mise run console:inspect` right after creating the Administrator role and after changing the team or role settings** (in the [downstream production rollout](docs/console-production-rollout.md), also at step 4 (the step that adds the Admin tier)). A team value in a trust policy that is not a team of the role's tier is `trust_team_tier`, and a retired team name left in a trust policy is `trust_team_retired` (both errors).
- Order: publish the issuer (the discovery and JWKS of the console Worker) before you deploy this stack. IAM reads the discovery document when it creates a provider; this order is inferred from that mechanism and was not measured with the single issuer.
- Deploy and update with a principal other than the console-login roles (for example the StackSets execution role). A console-login role session with a guard policy attached cannot update this stack.
- The provider ARN is an output but not an export. The role template builds the ARN from `IssuerHost`, `IssuerPath`, and the account ID (`AWS::AccountId`), so the role stack parameters contain no account ID.
- Deleting the provider (L2) is done outside CloudFormation and stops Viewer too; see "Stopping issuance without relying on Cloudflare (L2 and trust policy Deny)".

### Role stacks

`mise run console:config:generate` writes one role template per kind (`kind.<kind>.yaml`, generated from `roles` in the config) and its parameters (`stacksets.json`: for each role, the teams it accepts, as `<Role>Teams`, for example `ViewerTeams`). A role whose parameter is empty is not created. Each role gets a trust policy for the console provider of its boundary (the team tag with the teams in `<Role>Teams`, whose `AllowedPattern` accepts only the teams assigned to that role in that kind; `TagKeys`; SourceIdentity required), the `aws login` policy (Standard: same device and `--remote`; Admin: same device only), and its tier's guard policy. The reference output is [`infra/aws/console/kind.example.yaml`](infra/aws/console/kind.example.yaml); regenerate it with `mise run console:template:example` after changing the generator.

- The template is a reference shape. You may write roles by hand, but keep the structural requirements (the tier, the path `/awsbridge-console/<tier>/`, the shape of the trust policy, and that the stops work; `docs/specs/console-login.md` §4.8). How strong a hand-made role is, is the downstream's responsibility.
- Deploy the kind stacks (name pattern `awsbridge-console-kind-<kind>`) with StackSets, or with CloudFormation for single accounts, using a principal other than the console-login roles.
- The Administrator role goes in a separate stack; see "Adding the Admin tier and the Administrator role".

### Adding the Admin tier and the Administrator role

There is no separate Admin Worker, issuer, key, or host: the teams of the Admin tier get their own Access applications on the same portal host, and the console Worker issues for them at `/t/<team>`. In production, add them in the order of [Rolling out console login in production](docs/console-production-rollout.md): first a weaker Admin-tier role without Administrator (step 4), then, after a person approves, the Administrator role (step 5).

- Give the Admin-tier teams new names that no Standard team uses or has used (acceptance d; the generator also rejects a ledger name and a change of tier for the same name).
- Give their Access applications a short session (`admin_session_duration` in the reference Terraform, default 15 minutes) and keep the var `ADMIN_ACCESS_MAX_AGE_SECONDS` (default `900`) in line with it.
- `ADMIN_LOGIN_DISABLED` stops new issuance for the Admin-tier teams only; `LOGIN_DISABLED` stops everything.

Order for deploying Administrator (**an example that has not been run yet**; to be confirmed in the downstream production rollout): add the teams of the Admin tier (Access applications with a short session) and the role to the config, run `mise run console:config:generate`, deploy the Worker with `ADMIN_LOGIN_DISABLED` set to `"true"`, and then create the Administrator role in a **separate stack** from the Viewer stack (such as `awsbridge-console-kind-default`), from the same kind template (the generated `kind.<kind>.yaml`). The Viewer stack can still be updated while Administrator is stopped, and aborting takes a single stack deletion. Conditions:

- Give the stack a name that does not match the pattern `awsbridge-console-kind-<kind>` (for example `awsbridge-console-admin-default`). A fake kind name could match the SCP and CI conditions (the name pattern of kind stacks).
- In the Admin stack, set only `AdministratorTeams` and leave the other team parameters empty. **In the Viewer stack, keep `AdministratorTeams` empty** (do not create the same role name from two stacks). The `AllowedPattern` of `AdministratorTeams` accepts only the teams of the Admin tier assigned to Administrator in that kind (a Standard team cannot be passed).
- Look at the creation change set and confirm it contains **only an `Add` of `AdministratorRole`** before you execute it.
- Right after creation and before the first issuance, confirm with `aws iam get-role` that the trust policy names the console provider and that its team condition holds only teams of the Admin tier, and with `aws iam list-attached-role-policies` that the Admin guard policy is attached, and run `mise run console:inspect` (the commands in the Administrator inventory section). Only after these checks pass, set `ADMIN_LOGIN_DISABLED` back to `"false"` and deploy (step 5 of the rollout document).
- Whenever you update the Viewer stack, look at the change set; **if `AdministratorRole` appears, do not execute it** (the Viewer stack's `AdministratorTeams` is no longer empty).
- To abort, **delete the Admin stack, and remove Administrator from the config and regenerate** (so that the artifacts and the portal list do not keep Administrator), then deploy the Worker and confirm that the portal no longer shows Administrator.

## Daily operations

Once console login is live, run two checks every day: the reconciliation of issue records with CloudTrail (`console:reconcile`) and the check of the console issuers from outside (`console:exposure-check`). Rotate the signing keys on a schedule.

### Reconciling console logins (issue records x CloudTrail)

`mise run console:reconcile` matches the console Worker's issue records (the structured log `console_issue`) against the CloudTrail `AssumeRoleWithWebIdentity` events of the profile's account, using the JWT `jti` (= `requestParameters.webIdentityTokenId`). It reports **assumptions with no issue record** (a forged JWT, or issuance outside the Worker) as errors. Reconciliation is detection material, not proof of completeness (a compromised Worker can also write fake records). **The issue records are written by the console Worker itself. Against anyone who can write to the console Worker (including people who handle only Viewer), the reconciliation is not independent detection** (an accepted limit; see the acceptance section at the top).

- One account per run (`--profile` is required). It reads CloudTrail in **all enabled regions** of the account (`account list-regions`; `ec2 describe-regions` if that is not allowed). A region it cannot read is an error.
- It runs only four read-only aws commands: `sts get-caller-identity`, `account list-regions`, `ec2 describe-regions`, `cloudtrail lookup-events`. The profile needs `sts:GetCallerIdentity`, `account:ListRegions` (or `ec2:DescribeRegions`), and `cloudtrail:LookupEvents`.
- It looks only at console assumptions (role path `/awsbridge-console/`, or a provider whose host is a configured issuer host). MCP assumptions are not counted. A console role assumed through a provider that is not in the config is an error.
- Excluded assumptions: the number of `AssumeRoleWithWebIdentity` events that match neither and are left out of the reconciliation is printed as `excluded assumes (not console): <n>` (not a finding; the exit code does not change). The expected value is 0 if you do not use MCP in the same account. On the first run, and on any day it is not 0, check the following: in CloudTrail, look at the role ARN and the provider (`userIdentity.identityProvider`) of those events and confirm they are the MCP roles (`FederatedAwsBridgeMcpViewer` and so on) and the MCP issuer. If not, check whether a role outside the path was assumed through a provider that is not in the config (for example an entry point an Administrator left behind; see the Administrator inventory section), and escalate to your technical decision maker.
- Issue records come from one of two inputs:
  - `--records <file|dir>`: NDJSON (plain lines, Logpush Trace Events envelopes, or Workers Logs events; `.gz` is read too).
  - `--logs-api`: reads Workers Logs with the Cloudflare API (`POST /accounts/{account_id}/workers/observability/telemetry/query`). This query is the only Cloudflare API the tool calls. For each window the tool first gets the number of matching events (the `calculations` view, trusted only when `abr_level` is 1 and `sampleInterval` is 1), then reads the events. Long windows can be sampled (`abr_level` > 1), so when the rows read fall short of the count or the read is sampled, the tool halves the window and reads again. If a 1-minute window still falls short, it reports `record_read_incomplete` (error), exits with 1, and does not advance the state.
- Where issue records live (stage 2, the personal environment): Workers Logs (7 days of retention on Workers Paid). The wrangler config of the console Worker pins `observability.head_sampling_rate` to `1` so that sampling never drops a record.
- Retention window: the default lookback is 6 days (shorter than the 7-day retention). Assumptions older than the record retention that have no record are counted separately as `unverifiable`. A lookback longer than the retention is a warning (`--retention-days` changes the retention).
- Truncated record lines (`$cloudflare.truncated` and similar) and unreadable lines are errors; only their positions are printed.
- Time check: for a matched pair, if the assumption happens later than the issue time (`jwt.iat`, or the record time when absent) by more than "JWT lifetime 300 s + clock skew", it is reported as `assume_time_gap` (error, exit code 1). An assumption earlier than the issue time by more than the clock skew gets the same finding (a clock anomaly, or a record fitted to a forged JWT; the direction is shown as `+NNNs` / `-NNNs` in the detail). The default clock skew is 60 s and `--clock-skew-seconds <n>` changes it. The legitimate differences measured in stage 2 fell within this range, so it was raised from a warning to an error. The line `time from issue: standard n=<count> min <s>s max <s>s, admin ...` shows, per tier, the count, minimum, and maximum of the time from issue to assumption for matched pairs (kept as a record for revisiting the threshold).
- Identity check: only when both the issue record's user (the value used as SourceIdentity) and the CloudTrail SourceIdentity are present, they are compared in their masked form (`a***@***.com`); a difference is `identity_mismatch` (error, exit code 1). Issue records keep the email masked, so the comparison is a weak match (only the first character and the trailing domain): **it can only catch a different domain or a different first letter**, and it cannot tell apart another person with the same first letter and domain (a match does not prove it is the same person). Pairs where either side is missing are not skipped silently: the counts are printed as `identity: compared <n>, not compared <m> (admin <k>)` and as `identity_not_compared` (note). For the Administrator tier (roles of the Admin tier: a pair where the record's tier, the tier of the record's team, or the role path `/awsbridge-console/admin/` says Admin; the provider is shared by both tiers and does not decide the tier), each pair that could not be compared is `identity_not_compared_admin` (error, exit code 1). This tier covers every role of the Admin tier, not only the Administrator: an assumption of a weaker Admin-tier role that cannot be compared is also an error.
- Tier checks: a record whose tier differs from the tier of the role path is `tier_mismatch`; a record whose team has a tier in the config that differs from the record's tier or the role path's tier is `team_tier_mismatch`; a record of a team that is not in the config is `team_not_in_config` (all errors).
- Administrator-tier issuance: `admin issues: <n> (<time> <result>, ...)` shows the number of Admin-tier issue records in the window read, with each time (UTC) and result. In the daily reconciliation, check that there is no issuance you do not recognize. There is no immediate notification of Admin issuance (handled in stage 3).
- Confirmed interval: per account, the end of the "confirmed interval" is kept in a state file (`--state <file>`, default `.secrets/console-reconcile-state.json`; `.secrets/` is gitignored). If this run starts later than that end (an interval nobody read), it is `coverage_gap` (error, exit code 1). With no file (first run) there is no gap, and the output says `coverage: first run`. The file holds only the account ID and a time; never a token, email, or `jti`. **Only a run with exit code 0 advances the interval** (to "this run's end minus the propagation lag"): advancing on a run with errors or unverifiable assumptions would move them out of the next run's range and bury them. A corrupt state file is not treated as a first run; the tool refuses to run (exit code 2). To clear a gap, investigate and then re-run with `--since` set at or before the previous end (delete the state file only when you decide to accept the gap).
- The output is redacted (`jti` shows its first 8 characters, no email, account IDs show the last 4 digits). The summary shows the window read, the number of regions, the unverifiable count, truncated lines, and where the records came from (`source: api` or `file`).
- Exit codes: `0` no errors / `1` errors, or one or more unverifiable assumptions (even with zero errors) / `2` could not run (input, aws, or API failure).
- Variables (`mise.local.toml`): `AWSBRIDGE_CONSOLE_LOGS_TOKEN` (API token for `--logs-api`; environment variable only), `AWSBRIDGE_CONSOLE_LOGS_ACCOUNT_ID` (Cloudflare account ID), `AWSBRIDGE_CONSOLE_LOGS_WORKERS` (optional; Worker names, default `awsbridge-console`), `AWSBRIDGE_CONSOLE_CONFIG` (config file).
- Token: a read-only token is preferable, but according to the Cloudflare API specification `telemetry/query` accepts only the "Workers Observability Write" permission. Whether a Read-only token works is to be checked in stage 2. Limit the token to Workers Observability; do not give it permission to write Workers or secrets.

```bash
mise run console:reconcile -- --profile <profile> --logs-api               # from Workers Logs (default lookback 6 days)
mise run console:reconcile -- --profile <profile> --records ./issue-logs/  # from exported files
mise run console:reconcile -- --profile <profile> --logs-api --since 2026-11-10T00:00:00Z
```

Operations:

- **Run the reconciliation every day, whether or not an Administrator issued anything.** Even if you cannot run it on some day, no verification gap opens as long as you run it within 6 days. Issue records are kept for 7 days, so **an issuance not reconciled within 7 days cannot be verified later**. The tool reports the skipped interval as `coverage_gap` (error, exit code 1).
- **A run with errors does not advance the interval.** Once you have investigated the errors and settled them, re-run with `--since` set at or before the previous end, which advances the interval. Anything past the 7-day record retention can no longer be verified. If you leave it, `coverage_gap` errors pile up from the next run on.
- **When `assume_time_gap`, `identity_mismatch`, or `identity_not_compared_admin` appears**: stop issuing with the stop switch (set the var `ADMIN_LOGIN_DISABLED` to `true` for an Admin issuance, otherwise `LOGIN_DISABLED`), investigate the issuance and the assumption (the issue record and the CloudTrail event), and escalate to your technical decision maker. While an error remains, the interval does not advance. Issue records (Workers Logs) are kept for 7 days, and after that the issuance can no longer be investigated, so do not leave it.
- **Make `--since` at least 5 minutes longer than your run interval** (the confirmed interval ends at "this run's end minus the propagation lag, 300 s by default", so an exactly matching length leaves a gap). Example: if you run it every day, keep the default of 6 days.
- The daily run is done outside awsbridge (for example an agent over MCP). awsbridge has no scheduler. Notifications are also outside awsbridge; the operator decides how to do it.
- At the start of stage 2, check against real data: the shape of the Cloudflare API response (`events`, the `$metadata.id` cursor, what `count` means, whether the truncation flag is `$workers.truncated` or `$cloudflare.truncated`) and the CloudTrail `AssumeRoleWithWebIdentity` field names (`requestParameters.webIdentityTokenId`, `userIdentity.identityProvider`, and so on). If they differ, fix `scripts/console/reconcile-cf.ts`, `src/console/reconcile-input.ts`, and the fixtures.

### Checking the console issuers from outside (daily)

`mise run console:exposure-check` fetches each console issuer's `/.well-known/openid-configuration` and `jwks.json` from the outside and compares them with the public keys in your configuration. The AWS IAM OIDC providers trust the JWKS served at the issuer host, so if a Route or similar replaces the response of that host, a forged JWT (an Administrator, for example) could be accepted. This is the daily check for "what awsbridge serves is what it should serve". Together with `console:reconcile` it makes the two daily checks: (i) this comparison from the outside, (ii) the reconciliation above.

- **Targets**: every boundary issuer (the same issuer for Viewer and Administrator).
- **What it compares with**: the public keys in the vars of the wrangler config (`CONSOLE_PUBLIC_JWKS`, the same file `console:key:check` reads) and the boundary issuer URLs in the generated `worker.json`. It does not only compare `kid`: it compares the key contents (`kty`, `n`, `e`, `alg`, `use`, and any extra member), the `issuer` and `jwks_uri` of the discovery document, and the HTTP status (200 only).
- **What is an error** (it says "match" only when everything matches): a status other than 200, a **redirect (not followed; it is an error)**, a fetch failure or timeout, a response that is not JSON or has the wrong shape, an `issuer` / `jwks_uri` that differs, a key that is missing, **an extra key**, a key whose contents differ, a duplicate `kid`.
- **How it fetches**: so that the local DNS (including its negative cache) cannot affect the result, it resolves the host with public DNS over HTTPS (`https://cloudflare-dns.com/dns-query`, A and AAAA), connects to that IP over TLS, and sends the original host name as the SNI and `Host` (the certificate is verified against the host name). One GET per document, no retry, 10 s timeout. It uses **no Cloudflare or AWS token** and sends no `Authorization` header: it is public HTTP GETs only.
- **Output and exit codes**: `[OK]` / `[NG]` lines per issuer and a conclusion. Responses' values (`n`, the `kid` of a foreign key) are not printed; account IDs and emails are redacted. `0` all match / `1` some mismatch / `2` could not run (config unreadable, no expected keys, and so on).
- Variables (the same as the key tools; set them in `mise.local.toml`): `AWSBRIDGE_CONSOLE_OUT_DIR` (default `.generated/console`), `AWSBRIDGE_CONSOLE_WRANGLER_CONFIG` (default `wrangler.console.jsonc`). Run `mise run console:config:generate` first.

```bash
mise run console:exposure-check
```

Limits and what the zone owner keeps:

- **Watching the zone's configuration is the zone owner's operation.** awsbridge does not hold a token that can read the zone. What to watch: **there is no Route that hits the two console hosts (the portal and the issuer)**. Count the Routes that hit them through a wildcard such as `*.<zone>/*` too. Example of how to check: use a token with Zone Read or similar on the spot and read **all pages** of `GET /zones/{zone_id}/workers/routes`. **If the list cannot be read, or the read stops partway, do not treat it as 0 Routes.** awsbridge does not keep a token for this at all times. When you change a Custom Domain, check once with the same token you used for the change, before you delete that token.
- **The comparison from the outside is detection, not prevention.** A replacement that remains is found by the next check, but something added and removed between two checks is not found. If a Route is laid over the portal host, an issuance as a logged-in user may be possible, and that issuance looks normal in the reconciliation (a guess; not measured).

### Key rotation

#### Signing key rotation (MCP relay)

This is the procedure for replacing the MCP Worker's signing key (secret `SIGNING_JWK`) without downtime. STS caches the JWKS, so simply swapping the key would make verification fail right after the switch. Therefore, the new key's public key is first published in the JWKS (`/.well-known/jwks.json`), and signing is switched only after STS has picked it up.

```
mise run key:prepare    # 1. Generate the next key (AWSBRIDGE_NEXT_KEY_FILE. Aborts if it already exists)
mise run secrets        #    Publish the next key's public key in the JWKS (signing still uses the current key)
# ── Wait at least 1 hour (24 hours to be safe): until STS's JWKS cache expires ──
mise run key:activate   # 2. Current → PREVIOUS, NEXT → current
mise run secrets        #    Switch signing to the new key (the previous key's public key stays in the JWKS)
# ── Wait at least as long as the JWT lifetime (5 minutes) ──
mise run key:retire     # 3. Delete the previous key (PREVIOUS)
mise run secrets        #    Remove the old public key from the JWKS
```

- The length of STS's JWKS cache is not public, so the wait times are guidelines. The first wait is at least 1 hour, or 24 hours to be certain. The second wait is at least the JWT lifetime (5 minutes); also allow some margin for the `cache-control: max-age=300` of `/.well-known/jwks.json`.
- If the files `AWSBRIDGE_NEXT_KEY_FILE` / `AWSBRIDGE_PREVIOUS_KEY_FILE` (by default, `.next` / `.previous` added before the extension of `AWSBRIDGE_KEY_FILE`) exist, `mise run secrets` registers **only their public keys** in the secret `ADDITIONAL_PUBLIC_JWKS` (no private components go into the secret). If neither exists, it registers an empty array `[]` and clears the previous additional keys. Signing is always done only with `SIGNING_JWK` (the current key).
- Key files are created with mode 0600 and are never overwritten. Each task checks existence before acting and, if the conditions are not met, aborts without changing anything (`key:prepare`: NEXT already exists; `key:activate`: NEXT is missing or PREVIOUS already exists). `key:retire` does nothing if PREVIOUS is missing.
- If an **element** of `ADDITIONAL_PUBLIC_JWKS` is invalid (a short key, broken base64url, non-RSA, and so on), the Worker discards only that element, logs `jwks: invalid additional key skipped (index=<n>)` as a warning, and still returns the signing key's public key and the valid additional keys (the JWKS as a whole does not stop). If it is broken as JSON or is not an array, it returns 200 without additional keys. Only when `SIGNING_JWK` is invalid does it return 500 `server_misconfigured`. Note that STS cannot verify a signature made with a discarded key, so `mise run secrets` applies the same validation to the next / previous key files and stops without registering if they do not pass.
- For details of the mechanism, see the section on signing key rotation in `docs/specs/architecture.md`.

#### Console login signing keys

Per boundary; every 90 days or less; always rotate and remove the old kid if a compromise is suspected; one key, so it affects both Viewer and Administrator:

```bash
mise run console:key:put -- --boundary managed --yes      # 1. upload a new key under a new name
# 2. set that boundary in vars CONSOLE_PUBLIC_JWKS to the old and new keys and deploy (both in the JWKS)
# -- wait at least 1 hour (24 hours to be safe): until the STS JWKS cache expires --
# 3. set that boundary in vars CONSOLE_CURRENT_KEYS to the new key, deploy, and run mise run console:key:check
# 4. wait longer than the JWT lifetime (5 minutes), remove the old public key from CONSOLE_PUBLIC_JWKS, and deploy
mise run console:key:retire -- --binding CONSOLE_KEY_<old key> --yes   # 5. delete the old key (refuses current keys, keys still in the vars or JWKS, and the CSRF key)
```

## Stopping issuance (console login)

| Method | How | What it stops |
|---|---|---|
| Stop switch | Set the var `LOGIN_DISABLED` to `true` on the console Worker and deploy (issuing then returns `503 login_disabled`) | New issuance for every team |
| Admin stop switch | Set the var `ADMIN_LOGIN_DISABLED` to `true` and deploy (the same `503 login_disabled`, only for the teams of the Admin tier) | New issuance for the Admin-tier teams |
| Remove a kid | Remove the kid from that boundary in `CONSOLE_PUBLIC_JWKS` and deploy (if it is the current key, the Worker treats the vars as broken and every route returns `500 server_misconfigured`) | Issuing with that key, for Viewer and Administrator alike (one key per boundary). Removing the current kid stops every route of every boundary and both tiers |
| Delete the provider (L2) | "Stopping issuance without relying on Cloudflare (L2 and trust policy Deny)" below; does not rely on Cloudflare | New assumptions of every console role in that account, Viewer included |
| Deny in the trust policy | "Denying in the role trust policy" below; does not rely on Cloudflare | New assumptions of that role (the way to stop only Administrator) |
| Delete the Administrator stack | Delete the separate Administrator stack in that account; does not rely on Cloudflare | New Administrator assumptions in that account (whether it also ends sessions already issued has not been measured) |
| Revoke (L3) | Revoke the role's active sessions (IAM "Revoke active sessions") | Sessions already issued for that role |
| Stop one person (L3-1) | "Stopping one person for console login" below | That person's existing and new sessions |

- Only revoke (L3) and the one-person stop (L3-1) stop AWS sessions that were already issued. The others stop new issuance or new assumptions only.
- Neither revoke nor the one-person Deny invalidates `aws login` refresh tokens: once you remove them, `aws login` gets new credentials at the next refresh without signing in again. When to remove them is in `docs/specs/console-login.md` §6.3.
- Complete each stop by confirming that a request is refused, not by waiting a fixed time (`docs/specs/console-login.md` §6.1).
- **When the Worker cannot be relied on to stop**: if you cannot deploy the Worker, cannot confirm `503 login_disabled`, or cannot trust the Worker (its code, secrets, deploy permission, or dependencies may be compromised), do not keep trying the stop switches. Stop on the AWS side instead: a Deny in the trust policy, deleting the Administrator stack, or deleting the provider (stops Viewer too), as in "Stopping issuance without relying on Cloudflare (L2 and trust policy Deny)" below. Add revoke (L3) for sessions already issued.

### Stopping one person for console login

To stop a single person, the person's SourceIdentity (email by default) is written as a Deny into the inline policy with the reserved name `AwsbridgeConsoleDenySourceIdentity` on the console login roles (a Deny of every action for sessions whose `aws:SourceIdentity` matches; design in `docs/specs/console-login.md` §6.3). The stop tool writes it.

- The stop list is a file in the same form as the inspect tool's `--stops` (`{ "sourceIdentities": ["..."] }`), and it is the source of truth for who is stopped. **It contains email addresses, so keep it in `.secrets/` or in your downstream repository, and never commit it to the public repository.**
- `console:stop:apply` aligns the reserved policy on every target role with the list in the file. The targets are the configured roles that exist in the account, roles under the `/awsbridge-console/` path, and roles outside the path that are not in the config but trust a console provider (the plan marks them as roles not in the config, with the source `unlisted`).
- Without `--yes` it only shows the plan. It still reads IAM and calls `sts get-caller-identity` to compute the difference from the current state (unlike the key tool, where no API is called without `--yes`). The only writes are `iam put-role-policy` and `iam delete-role-policy`.
- Without `--allow-remove` it only adds: each role's reserved policy becomes the union of its current values and the values in the file. Values on a role that are not in the file are kept, and only their count is shown as extra (`EXTRA`). Extra values alone leave the exit code at 0. A run that has nothing to add and only values to remove (a release only) writes nothing and exits with 2 unless `--allow-remove` is given.
- With `--allow-remove` it makes every role match the file (releasing a stop). It finishes adding on every role before removing, so a failure on the removing side never blocks the adding side. The tool prints the release conditions from §6.3 (do not remove before the role's `MaxSessionDuration` has passed, the cause is removed, old keys are gone, and new issuance is confirmed impossible). The tool cannot check them, so a person does. It also removes values from roles that are not in the config.
- In both cases it never halts the whole run for one role. Roles whose reserved policy holds a document that is not a stop document, roles whose inline policies would exceed 10,240 characters in total, and roles where the write fails are reported and left unwritten; the other roles are still written, and the tool exits with 1.
- `--reason` is required. The result is printed to standard output as a one-line JSON record (time, last 4 digits of the account, roles, change in counts, reason; no values), which the operator keeps. The output never contains email values or full account IDs.
- It refuses to run from a session of a console role (a configured role name or a role under `/awsbridge-console/`), because the guard policy denies the writes. Run it through another entry point such as IAM Identity Center.

```bash
mise run console:stop:show -- --profile=<p> --stops=.secrets/console-stops.json      # read only: counts per role, missing and extra
mise run console:stop:apply -- --profile=<p> --stops=.secrets/console-stops.json --reason="<reason>"         # show the plan
mise run console:stop:apply -- --profile=<p> --stops=.secrets/console-stops.json --reason="<reason>" --yes   # write
mise run console:inspect -- --profile=<p> --stops=.secrets/console-stops.json        # afterwards, check the configured roles
```

`console:inspect --stops` checks the configured roles. Roles not in the config and roles outside the path are checked by the stop tool's own read-back after writing (see the table in its output).

Exit codes: 0 done (or nothing to change; extra values alone still give 0) / 1 some roles were not written / 2 nothing was run (input error, read failure, the caller, or a release-only run without `--allow-remove`).

### Stopping issuance without relying on Cloudflare (L2 and trust policy Deny)

**There is no L2 that stops only Administrator** (acceptance e). Viewer and Administrator share one provider, so deleting the provider (L2) also stops Viewer. The ways to stop only Administrator without relying on Cloudflare are a Deny in the Administrator role's trust policy (below) and deleting the Administrator stack. None of these stops AWS sessions that were already issued, so combine them with revoke (L3). **It is done outside CloudFormation.** The deletion and the restore procedure below were run in the personal environment of stage 2 (on the per-tier Admin provider used before the console moved to one provider; the mechanism is the same): after the deletion, issuing failed at the portal with `upstream_auth_failed` ("this account is not accepting logins right now"), and a CLI session from before the deletion kept working. Recreating it with the same URL, client ID, and tags gave the same ARN, and the first issuance that arrived after the recreation (about 2 minutes later) succeeded.

1. With a principal other than the console-login roles, delete the console provider in the target account (the guard policy Denies only block writes from the console-login roles). Viewer stops too.

   ```sh
   aws iam delete-open-id-connect-provider --profile <operator profile> \
     --open-id-connect-provider-arn arn:aws:iam::<account ID>:oidc-provider/awsbridge-oidc-console.example.com/console
   ```

2. **While it is stopped, do not update the base stack (the stack instance for that account).** The provider has drifted from the stack, and what an update does in that state (fail, or recreate the provider) has not been measured. If it is recreated, the stop is undone.
3. To restore, recreate the provider with the same URL, the same client ID, and the same tags. The ARN is determined by the URL, so the role trust policies do not change.

   ```sh
   aws iam create-open-id-connect-provider --profile <operator profile> \
     --url https://awsbridge-oidc-console.example.com/console \
     --client-id-list awsbridge-console \
     --tags Key=project,Value=awsbridge
   ```

4. After recreating it, issue once, run stack drift detection, and confirm there is no difference before you resume stack updates; the recreated provider leaves no drift (in that run, the recreated provider's thumbprint also matched the original, and drift detection on the base stack was IN_SYNC).

Still not measured: what an update of the base stack does while stopped (not done in that run). The time from deletion until assumptions stop has only the measurement with the Standard shape, about 12 seconds (`docs/specs/console-login.md` §6.1).

#### Denying in the role trust policy

The other way to stop issuance without relying on Cloudflare, and the way to stop only Administrator. Add a `Deny` statement for `sts:AssumeRoleWithWebIdentity` to the trust policy of the role you want to stop (by hand, with a principal other than the console-login roles). In the same stage 2 run (a role of the Admin tier), issuing after the change failed at the portal with `sts_denied` ("could not enter this role"; CloudTrail shows `AccessDenied`), which is distinguishable from the provider deletion (`upstream_auth_failed`). Existing CLI sessions kept working (revoke is what stops those).

- **The trust policy Deny is outside CloudFormation's management. While it is stopped, do not update the role stack. Restore it by hand, and confirm with one issuance and drift detection.**
- In the two kinds of update measured (an update with no changes, and an update that changes only the stack tags), the Deny was not removed (CloudFormation did not write back the template's trust policy); whether an update that changes the trust policy itself removes the Deny has not been measured (for example a change of team assignments). Because it is not measured, do not update while stopped.

## Inventory of what an Administrator left behind (console login)

An Administrator has full rights in the target account, so it can leave entry points that keep working after console login is stopped: access keys, roles, providers, trust policy changes, and so on. Revoke (L3) and stopping one person (L3-1) do not stop these (`docs/specs/console-login-admin.md` §7). After stopping (or as a periodic check), take an inventory with the steps below and delete what was left, item by item. **The commands below are examples that have not been run yet**; they are to be confirmed in the stopping drill (stage 2, and the drill of the [production rollout](docs/console-production-rollout.md)). They only read; deleting is not written here. Run them with a profile for a principal other than the console roles (IAM Identity Center or similar). **This inventory does not guarantee a complete recovery**: it finds what the listed reads can show.

1. **The console role itself**: `mise run console:inspect -- --profile=<p>` compares the trust policy, managed policies (including the guard policy and its version), inline policies, `MaxSessionDuration`, and providers with the shape expected from the config. To look without the tool:

   ```sh
   aws iam get-role --role-name FederatedAwsBridgeAdministrator --profile <p>                     # trust policy (AssumeRolePolicyDocument), path, MaxSessionDuration
   aws iam list-attached-role-policies --role-name FederatedAwsBridgeAdministrator --profile <p>  # managed policies (only AdministratorAccess and the Admin guard policy?)
   aws iam list-role-policies --role-name FederatedAwsBridgeAdministrator --profile <p>           # inline policy names (AwsLogin, the reserved stop name, ...)
   aws iam get-role-policy --role-name FederatedAwsBridgeAdministrator --policy-name <name> --profile <p>
   ```

2. **Providers**: check that the OIDC providers are only the MCP one and the console ones (the boundary issuer; one for Viewer and Administrator). Compare the URL, client IDs, and tags with what the base stack creates. Check SAML providers too.

   ```sh
   aws iam list-open-id-connect-providers --profile <p>
   aws iam get-open-id-connect-provider --open-id-connect-provider-arn <ARN> --profile <p>
   aws iam list-saml-providers --profile <p>
   ```

3. **Writes made by that person's sessions**: from CloudTrail management events, pick those whose `userIdentity.sessionContext.sourceIdentity` is the person's SourceIdentity (email by default). `lookup-events` covers the last 90 days, one region at a time, and takes only one lookup attribute per call. It cannot filter by SourceIdentity, so narrow by `EventSource` or similar first, then filter on the contents of `CloudTrailEvent` (a JSON string). IAM events are mostly recorded in us-east-1 ("Global service events" in the CloudTrail documentation, which notes that some global service events are logged in other regions). Check each enabled region, including for other services. **Whether `sourceIdentity` stays on the events of operations after the assumption (listed as unverified in `docs/specs/console-login.md`) has not been checked in this repository yet.** It is to be checked in stage 2; if it does not, this procedure will be changed (for example, to pick events by the RoleSessionName `console-<email>`).

   ```sh
   aws cloudtrail lookup-events --region us-east-1 --profile <p> \
     --lookup-attributes AttributeKey=EventSource,AttributeValue=iam.amazonaws.com \
     --start-time 2026-11-01T00:00:00Z --output json \
     | jq '.Events[].CloudTrailEvent | fromjson
           | select(.userIdentity.sessionContext.sourceIdentity == "user@example.com")
           | {eventTime, eventName, requestParameters}'
   ```

   Operations to look for, for example: `CreateUser`, `CreateAccessKey`, `CreateLoginProfile`, `CreateRole`, `UpdateAssumeRolePolicy`, `PutRolePolicy`, `AttachRolePolicy`, `PutUserPolicy`, `AttachUserPolicy`, `CreatePolicyVersion`, `CreateOpenIDConnectProvider`, `AddClientIDToOpenIDConnectProvider`, `CreateSAMLProvider`. Outside IAM, also look for changes that open resource policies to other principals (S3 bucket policies, KMS key policies, Lambda function permissions and function URLs, and so on).

4. **A listing that does not rely on CloudTrail**: CloudTrail may have been stopped or deleted, so list the current IAM state and compare it with the previous listing (or the expected state). Do the same outside IAM: for the services you use, take the current resource policies (for example S3 bucket policies, KMS key policies, Lambda function policies and function URLs) and compare them with a baseline taken before the Administrator was used.

   ```sh
   aws iam get-account-authorization-details --profile <p> > authz-<date>.json   # all users, roles, groups, and policies (contains account IDs; do not put it in a public repository)
   aws iam list-users --profile <p>
   aws iam list-access-keys --user-name <user> --profile <p>
   ```

5. Delete what you found item by item after checking the cause, and record what you deleted and when. Do not lift the stop (L3, L3-1) in that account until the deletion is done (the lifting conditions in `docs/specs/console-login.md` §6.3).

## Migrating an existing MCP deployment

These sections apply only to an MCP relay deployed with an older version of awsbridge.

### Migrating an existing deployment (`AWS_PROFILES` was removed)

`AWS_PROFILES` used to be passed as a var or a secret (`AWSBRIDGE_PROFILES` in `mise.local.toml`). It was removed, so migrate as follows.

```
# Upstream's development deployment: write the contents of AWSBRIDGE_PROFILES (a JSON string) in mise.local.toml into config/profiles.json
cp config/profiles.example.json config/profiles.json   # Replace the contents with your list. Delete AWSBRIDGE_PROFILES from mise.local.toml
# Downstream repository: move vars.AWS_PROFILES in wrangler.<name>.jsonc to deploy/profiles.json, delete the vars, and add alias
mise run deploy:worker
# Delete the Worker secret that is no longer needed (only if you kept it as a secret; match --config / --env to the ones you used)
bash scripts/wrangler.sh secret delete AWS_PROFILES
```

The Worker no longer reads a leftover `AWS_PROFILES` var or secret (it is ignored). A secret stays on the Worker, though, so remove it with `secret delete`.

### Migrating: default role names changed and the debug role narrowed

The default role names changed: `FederatedMcpReadOnly` → `FederatedAwsBridgeMcpViewer` and `FederatedMcpDebug` → `FederatedAwsBridgeMcpDebugger`. For a short time the default was `FederatedMcpViewer` / `FederatedMcpDebugger`; if your stack uses those, the same migration applies (the parameter names `ReadOnlyRoleName` / `DebugRoleName`, the outputs `ReadOnlyRoleArn` / `DebugRoleArn`, and the environment variables `AWSBRIDGE_READONLY_ROLE_NAME` / `AWSBRIDGE_DEBUG_ROLE_NAME` stay the same).

- **The old names are kept only when you update an existing stack with `scripts/deploy-aws.sh` and do not set the names.** `scripts/deploy-aws.sh` (`mise run deploy:aws`) runs `aws cloudformation deploy` and passes a role name only when its environment variable is set; for an existing stack, parameters that are not passed keep the stack's current values. In the following cases the roles are replaced, and their `roleArn` and unique ID change: (1) you set new names with `AWSBRIDGE_READONLY_ROLE_NAME` / `AWSBRIDGE_DEBUG_ROLE_NAME` (this is how you move to the new names); (2) you deploy the template some other way (the management console, `create-change-set` / `update-stack` without `UsePreviousValue`, StackSets, and so on), where parameters you do not give may take the template's defaults, that is, the new names; (3) you delete the stack and create it again.
- **Before migrating, preview the change.** Run `aws cloudformation deploy` with the same arguments as `scripts/deploy-aws.sh` plus `--no-execute-changeset`, then check with `aws cloudformation describe-change-set --stack-name <stack> --change-set-name <name> --query 'Changes[].ResourceChange.[LogicalResourceId,Action,Replacement]'` whether `ReadOnlyRole` / `DebugRole` show `Replacement: True`. A change set changes nothing unless you execute it; delete it afterwards with `aws cloudformation delete-change-set`.
- **Before migrating, check what refers to the old role ARNs:** KMS key policies, S3 bucket policies, SCPs, other roles' trust policies, and so on. Policies that name the old ARN stop matching the new role. A role in the `Principal` of a resource policy is stored by its unique ID, so after a replacement the trust does not come back even if the new role has the same name: update those policies.
- **Deleting the OIDC provider or changing a trust policy does not revoke STS credentials already issued.** Sessions of the old roles stay valid until they expire (the Worker requests 900 seconds; the upper limit is the role's `MaxSessionDuration`, 3600 seconds by default). To stop them at once, revoke the old roles' active sessions (IAM "Revoke active sessions") before deleting them.
- **Confirm deletions in IAM, not only in CloudFormation.** After deleting a stack, check in every target account that the roles and the OIDC provider are actually gone.
- **The debug role can no longer read secret values through the API.** `SecretRead` (`secretsmanager:GetSecretValue`, `ssm:GetParameter*`) and `SecretDecrypt` (`kms:Decrypt`) were removed, and both roles now deny those reads with no condition. This is a breaking change, and it cannot be undone with `DebugAdditionalPolicyArns` (an explicit Deny wins). It applies when you update the stack, whether or not you rename the roles.

#### Same stack (rename the roles; MCP fails during the switch)

1. Update the stack with the new names: `AWSBRIDGE_READONLY_ROLE_NAME=FederatedAwsBridgeMcpViewer AWSBRIDGE_DEBUG_ROLE_NAME=FederatedAwsBridgeMcpDebugger AWS_PROFILE=<target> mise run deploy:aws`. Note the new outputs `ReadOnlyRoleArn` / `DebugRoleArn`.
2. Update the `roleArn` values in the profile list (`config/profiles.json`, or `deploy/profiles.json` downstream).
3. Deploy the Worker: `mise run deploy:worker`.
4. Check that both roles work (call a tool with a read-only profile and a debug profile).

From step 1 until step 3 is done, MCP calls fail (the profile list still points at the old ARNs, which no longer exist).

#### Separate stack in parallel (when the issuer URL also changes)

If you also change the issuer URL (the issuer host), you can run a new stack next to the old one and switch with almost no downtime. Use values different from the old deployment for all three of: the issuer URL (`AWSBRIDGE_ISSUER`), the stack name (`AWSBRIDGE_STACK_NAME`), and the role names (`AWSBRIDGE_READONLY_ROLE_NAME` / `AWSBRIDGE_DEBUG_ROLE_NAME`). An account has only one IAM OIDC provider per URL, and role names are unique within an account, so if any of them is the same, the two stacks cannot coexist. No upstream code change is needed (all of them are already parameters).

Decide these before you start:

- **Deleting the old stack is part of the migration. Set a deadline for it.** The old debug role keeps `SecretRead` until its stack is deleted, so "secret values cannot be read directly through the API" does not hold until then.
- **Whether the old and new deployments share the signing key.** If they share it, a leaked key still reaches the old roles (including the old debug role that can read secret values) until the old stack is deleted, so the deadline matters even more. If you separate them, point `AWSBRIDGE_KEY_FILE` at a new file and run `mise run keygen` for the new deployment; this is a chance to renew the key (see "Signing key rotation (MCP relay)" for the existing procedure).
- **A new URL also changes the Cloudflare Access application (AUD) and the MCP clients' server URL.** Protect the new connection host with an Access application and keep `/.well-known/*` public on the new issuer host (see `infra/cloudflare` and "Decide the hosts"), and set the new Worker's `ACCESS_AUD` (`AWSBRIDGE_ACCESS_AUD`) to the new application's AUD. The Worker verifies the Access JWT against `ACCESS_AUD` itself, so a request that reaches it without passing Access (the issuer host, another host, a Preview URL) gets 401; check this on the new hosts too (for example, `/mcp` on the issuer host returns 401). Keep workers.dev and Preview URLs closed (`workers_dev` and `preview_urls` set to `false`, as in the custom domain form).

Steps (the Worker comes first: IAM reads the issuer's `/.well-known/openid-configuration` when it creates the OIDC provider, as on the first deployment):

1. Deploy a second Worker under another name that answers at the new URL, with `ISSUER` set to the new URL (for example another wrangler config via `AWSBRIDGE_WRANGLER_CONFIG` / `AWSBRIDGE_WRANGLER_ENV`, and `AWSBRIDGE_ISSUER` set to the new URL; `mise run deploy:worker` passes `ISSUER` and bundles the profile list in the same deploy. A new Worker needs the explicit route, `AWSBRIDGE_WRANGLER_DEPLOY_MODE=deploy`). STS fetches the discovery document and the JWKS from the issuer URL, and the discovery document's issuer is the Worker's `ISSUER`. A Worker has only one `ISSUER`, so the old Worker cannot serve the new issuer: running both side by side needs this second Worker. Its profile list can hold dummies at this point, as on the first deployment.
2. Deploy the new stack with `mise run deploy:aws`, setting the new `AWSBRIDGE_ISSUER`, `AWSBRIDGE_STACK_NAME`, and role names. Do this in every target account.
3. Write the new `roleArn` values in the new Worker's profile list and deploy it again.
4. Before switching the clients, confirm once that the new roles can be assumed: `AWSBRIDGE_ISSUER=<new URL> AWSBRIDGE_STACK_NAME=<new stack> AWS_PROFILE=<target> mise run poc:sts` (it signs a JWT with `AWSBRIDGE_KEY_FILE`, which must be the key of the Worker at the new URL; for the debug role, pass `--role-arn <DebugRoleArn>`).
5. Change the MCP clients' server URL to the new connection URL (`https://<connection host>/mcp`; it differs from the issuer URL when you use separate hosts, as in "Decide the hosts"). The connection URL and the Access application are new, so clients need to be reconfigured and authorized again.
6. Check that both roles work.
7. By the deadline, delete the old stack in every account (`AWSBRIDGE_STACK_NAME=<old stack> AWS_PROFILE=<target> mise run destroy:aws`). This removes the old OIDC provider and roles. Confirm in IAM that they are gone in every account.
8. Only after the old OIDC provider is gone from every account, remove the old Worker and give up the old issuer host name (the domain, or the workers.dev subdomain). In the reverse order, if a third party takes over the released host name, a remaining provider would trust it as an issuer.

This way you can check the old and new deployments side by side before you switch. Without a second Worker this is not a parallel migration: the new stack can be created only after the Worker's `ISSUER` has moved to the new URL, and from then until the new stack and the new `roleArn` values are deployed, MCP calls fail (the old roles no longer accept the Worker's tokens). If you do it that way, prepare the rollback first (redeploy the Worker with the old `ISSUER` and the old `roleArn` values; keep the old stack until the new one works).

## Development

Runtimes and commands are managed with [mise](https://mise.jdx.dev/). `mise tasks` lists every task.

```
mise install            # runtimes and tools (node, pnpm, cfn-lint, terraform, tflint, gitleaks)
mise run install        # dependencies (pnpm install)
mise run test           # unit + e2e (test:unit / test:e2e; the e2e tests start wrangler dev)
mise run lint           # biome, type check, cfn-lint on the CloudFormation templates, Terraform samples
mise run fmt            # format
mise run build          # bundle the MCP Worker without deploying
mise run dev            # run the MCP Worker locally
mise run secrets:scan   # gitleaks on the commit history and the working tree
```

For verification only: the `poc:*` tasks call real AWS or Cloudflare and are used only when you run them explicitly (for example `mise run poc:sts`: one positive and four negative cases of `AssumeRoleWithWebIdentity` with a JWT signed by the MCP key).
