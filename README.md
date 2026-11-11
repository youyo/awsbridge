# awsbridge

English | [日本語](README_ja.md)

Bridge AI agents to AWS.

A Cloudflare Worker that converts the identity of a user authenticated by Cloudflare Access into per-user temporary AWS credentials (STS), signs requests with SigV4, and relays them to the AWS MCP Server. It is designed to sit behind a Cloudflare MCP Server Portal.

> Early development stage. For the design, see [docs/specs/architecture.md](docs/specs/architecture.md) (written in Japanese).

Predecessor: [youyo/aws-mcp-gateway](https://github.com/youyo/aws-mcp-gateway)

## Deployment

The Cloudflare side (Worker) and the AWS side (CloudFormation) are completely separate. Deploying the Worker does not call AWS, and deploying CloudFormation does not call Cloudflare. For each target AWS account, you only need to run CloudFormation.

### Prerequisites

- [mise](https://mise.jdx.dev/) (`mise install` installs the runtimes and cfn-lint)
- Cloudflare side: an account where you have run `wrangler login`
- AWS side: an AWS profile with permission to operate IAM and CloudFormation

### Order for the first deployment

The Worker's URL becomes the OIDC issuer, so proceed in this order.

1. Cloudflare side: `mise run keygen` → set `AWSBRIDGE_ISSUER` and the other variables in `mise.local.toml` → `cp config/profiles.example.json config/profiles.json` (required for the build. The contents can stay as dummies for now) → `mise run deploy:worker` (this fixes the Worker's URL. At this point the role ARNs are dummies, so `/mcp` is not usable)
2. AWS side: `AWS_PROFILE=<target> mise run deploy:aws` (note the outputs `ReadOnlyRoleArn` / `DebugRoleArn`)
3. Register the profile list. Write the role ARNs from the outputs into `config/profiles.json` (see "Multi-account" below) and run `mise run deploy:worker`. The list is a JSON file bundled into the Worker, not an environment variable, so the build fails without `config/profiles.json` (unset is an error)

From the second time on, deploy only the side you changed.

### AWS side (per target account)

Just deploy [infra/aws/awsbridge.yaml](infra/aws/awsbridge.yaml). It creates an IAM OIDC provider whose issuer is the Worker's URL, and two roles that are assumed with the JWT issued by the Worker (read-only `FederatedMcpReadOnly` and debug `FederatedMcpDebug`).

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
| `IssuerHost` | The Worker's host name (without `https://` and without a trailing `/`. Example: `awsbridge.example.workers.dev`) |
| `Audience` | The JWT audience (default `awsbridge`. Must match the Worker's `STS_AUDIENCE`) |
| `AllowedSubjects` | Users who can assume the read-only role (comma-separated. See the format below. Specify in lowercase) |
| `DebugAllowedSubjects` | Users who can assume the debug role (same format. Keeping it narrower than the read-only role is recommended) |
| `ReadOnlyRoleName` | Read-only role name (default `FederatedMcpReadOnly`) |
| `DebugRoleName` | Debug role name (default `FederatedMcpDebug`) |
| `DebugAdditionalPolicyArns` | Optional. Additional managed policies to attach to the debug role (comma-separated. Nothing is attached if empty) |
| `DebugPassableEcsTaskRoleArns` | Optional. IAM role ARNs that may be passed to a task with `ecs:RunTask` (comma-separated. Wildcards are not allowed). If empty, `iam:PassRole` is not granted |

After deployment, note the outputs `ReadOnlyRoleArn` / `DebugRoleArn` (you can also get them with `aws cloudformation describe-stacks`).

#### Role permissions and caveats

| Role | Permissions |
|---|---|
| `FederatedMcpReadOnly` | The AWS managed policy `ReadOnlyAccess` + an explicit Deny (unconditional) on retrieving SSM parameters (`ssm:GetParameter` / `GetParameters` / `GetParametersByPath` / `GetParameterHistory`) |
| `FederatedMcpDebug` | `ReadOnlyAccess` + an inline policy (enhanced read access for investigation, reading secret values, light operational actions, actions that incur cost, and connection and execution; conditional on `aws:CalledViaAWSMCP = aws-mcp.amazonaws.com`; includes a Deny on retrieving SSM parameters outside AWS MCP) + the optional `DebugAdditionalPolicyArns` |

The debug role's inline policy is divided into the following groups (every Allow is conditional on `aws:CalledViaAWSMCP = aws-mcp.amazonaws.com`, with Resource `*`). It does not include delete actions, IAM changes, or organization changes (a Knowledge Bases sync can still remove indexed documents as a result; see `Operations`).

| Group (Sid) | Contents |
|---|---|
| `Investigation` | Reads for investigation that go deeper than `ReadOnlyAccess`. Logs Insights / log retrieval / Live Tail, X-Ray, CloudTrail (`LookupEvents` and queries), running Athena queries, EC2 console output / screenshots, AWS Config `SelectResourceConfig` / `GetResourceConfigHistory` |
| `SecretRead` | Reading secret values: `secretsmanager:GetSecretValue`, `ssm:GetParameter(s)` / `GetParametersByPath`. Treat this as carrying the same risk as the execution group. `kms:Decrypt` for decryption is a separate Statement, limited to `kms:ViaService` (via Secrets Manager / SSM) |
| `DenyParameterReadOutsideMCP` | **Deny**: retrieving SSM parameters outside AWS MCP (`ssm:GetParameter` / `GetParameters` / `GetParametersByPath` / `GetParameterHistory`). The condition is `StringNotEquals aws:CalledViaAWSMCP = aws-mcp.amazonaws.com`, so it also applies to direct calls, where the key is absent (see the notes below) |
| `Operations` | Light operational actions with side effects (no deletion): ECS `UpdateService` / `StopTask`, starting, stopping, and rebooting EC2, changing Lambda concurrency, changing Auto Scaling capacity, rebooting RDS / ElastiCache, CloudFront `CreateInvalidation`, starting and stopping a Bedrock Knowledge Bases sync (`bedrock:StartIngestionJob` / `StopIngestionJob`). A sync is not a delete action, but documents removed from the data source (such as S3) are also removed from the vector store.<br>Stop, restart, and fail over: `states:StopExecution`, `glue:BatchStopJobRun` / `StopCrawler`, `codebuild:RetryBuild` / `StopBuild`, `autoscaling:SuspendProcesses` / `ResumeProcesses`, `rds:FailoverDBCluster` / `RebootDBCluster`, `elasticache:TestFailover`, `elasticbeanstalk:RestartAppServer`.<br>Stop or suppress: `cloudwatch:DisableAlarmActions` / `EnableAlarmActions`, `events:EnableRule` / `DisableRule` / `CancelReplay`, `autoscaling:SetInstanceHealth` / `EnterStandby` / `ExitStandby`, `rds:StartDBInstance` / `StopDBInstance` / `StartDBCluster` / `StopDBCluster`, `ssm:StopAutomationExecution`, `batch:CancelJob`, `codepipeline:StopPipelineExecution` |
| `CostIncurring` | Actions that **incur cost**: `bedrock:InvokeModel` / `InvokeModelWithResponseStream` (including Converse) / `ApplyGuardrail` / `RetrieveAndGenerate`, `sagemaker:InvokeEndpoint` / `InvokeEndpointAsync`, `rds:CreateDBSnapshot` / `CreateDBClusterSnapshot`, `ec2:CreateSnapshot`, `lambda:PutProvisionedConcurrencyConfig`. Permissions to share snapshots are not included |
| `Execution` | Connection and execution: `ssm:SendCommand` / `StartSession` and others, EC2 Instance Connect, `ecs:ExecuteCommand` / `RunTask`, `lambda:InvokeFunction`, `states:StartExecution`, `sqs:SendMessage`, `sns:Publish`, `rds-db:connect`. Running business logic and deployments: `states:RedriveExecution` / `StartSyncExecution`, `bedrock:InvokeAgent`, `lambda:InvokeFunctionUrl`, `glue:StartCrawler` / `StartWorkflowRun`, `ssm:StartAutomationExecution`, `events:StartReplay` / `PutEvents`, `codepipeline:RetryStageExecution`. `iam:PassRole` for `ecs:RunTask` is a separate Statement, granted only when `DebugPassableEcsTaskRoleArns` is specified; it limits the roles that can be passed to those ARNs and the recipient to `ecs-tasks.amazonaws.com` (if empty, only task definitions without a task role can be run) |

Athena queries also need a separate write permission (`s3:PutObject`) to the result bucket. This policy does not include it, so add it with `DebugAdditionalPolicyArns` if needed.

The Knowledge Bases sync actions (`bedrock:StartIngestionJob` / `StopIngestionJob`) also use Resource `*`, like the other groups. The debug role is meant to investigate any resource in the account, and the other actions (ECS, EC2, RDS, and so on) do not take target ARNs as parameters either, so there is no parameter to narrow them to Knowledge Base ARNs (`DebugAdditionalPolicyArns` only adds permissions and cannot narrow them). To narrow them, edit the `Operations` Resource in the template to `arn:${Partition}:bedrock:${Region}:${Account}:knowledge-base/${KnowledgeBaseId}`, or add an `aws:ResourceTag` condition.

- **The debug role includes permissions equivalent to remote execution.** `ssm:SendCommand` / `ssm:StartSession` / `ecs:ExecuteCommand` are equivalent to a remote shell, and secrets, credentials, and file contents may become visible. `SecretRead` can also read secret values themselves. `Operations`, as well as `lambda:InvokeFunction`, `states:StartExecution`, `sqs:SendMessage`, and `sns:Publish`, run processes with side effects.
- **The debug role includes actions that incur cost or run deployments.** Model and inference endpoint invocations, snapshot creation, and provisioned concurrency in `CostIncurring` are billed (`rds:StopDBInstance` can also create a snapshot). `codepipeline:RetryStageExecution` retries a failed stage and may run a production deployment. `events:StartReplay` / `PutEvents`, `bedrock:InvokeAgent`, `glue:StartCrawler` / `StartWorkflowRun`, and `ssm:StartAutomationExecution` run their targets, jobs, or automations. Depending on its settings, `glue:StartCrawler` deletes or deprecates catalog tables.
- **Remember to undo stop and suppress actions.** Leaving `cloudwatch:DisableAlarmActions`, `events:DisableRule`, or `autoscaling:SuspendProcesses` / `EnterStandby` in place can hide incidents or stop self-healing. An instance marked Unhealthy with `autoscaling:SetInstanceHealth` is terminated and replaced.
- **Retrieving SSM parameters outside AWS MCP is denied.** `ReadOnlyAccess` includes `ssm:Get*`, so without the Deny the session credentials could read SSM parameters directly (SecureString values with the `aws/ssm` key are also decrypted through the key policy). A negated condition operator such as `StringNotEquals` evaluates to true when the key is absent from the request ([condition operators](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_condition_operators.html)), and `aws:CalledViaAWSMCP` is not present on direct calls ([global condition keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html)). The Deny therefore applies to direct calls and not to calls through AWS MCP (value `aws-mcp.amazonaws.com`), so `SecretRead` through MCP works as before. Do not change this condition to `...IfExists` or `Null`.
- **Privilege escalation paths are closed.** Granting `iam:PassRole` on `*` would let tasks run with any role, so it is not granted by default and is limited to the roles explicitly listed in `DebugPassableEcsTaskRoleArns`. Also, `lambda:UpdateFunctionConfiguration` (swapping the execution role or environment variables) and `autoscaling:UpdateAutoScalingGroup` (swapping the launch template) are not granted. `glue:StartJobRun` and `batch:SubmitJob` are not granted: overriding job arguments or the command and environment variables can run arbitrary code with the job's role (the same reason as `codebuild:StartBuild`). `codepipeline:StartPipelineExecution` is not granted either: `sourceRevisions` can swap the source commit, S3 object, or image, and `variables` can pass arbitrary values into the pipeline (the same reason `codebuild:StartBuild`, which can override its arguments, is not granted; use `RetryStageExecution` to re-run). `iam:PassRole` for `ssm:StartAutomationExecution` is not granted, so automations run only within the caller's permissions.
- **Remaining risk:** `ssm:SendCommand` / `ssm:StartSession` / `ecs:ExecuteCommand` / EC2 Instance Connect can act with the permissions of the role attached to the target instance or task. If a highly privileged instance or task exists in the same account, those permissions can be borrowed. In production, narrow the targets with tag conditions or SSM documents.
- **The read-only role includes `ReadOnlyAccess`, so secret values other than SSM parameters can be read.** `ReadOnlyAccess` (v191) includes `ssm:Get*`, and SecureString values can also be decrypted via the `aws/ssm` key, so the read-only role explicitly denies retrieving SSM parameters (reading secret values is only possible through `SecretRead` of the debug role). The debug role also denies retrieving them outside AWS MCP (see above). On the other hand, Lambda environment variables (`lambda:Get*` / `ListFunctions`), `s3:GetObject`, and similar are used routinely in investigations and are not denied. If secret values are stored there, narrow `AllowedSubjects`, or add your own Deny with a permissions boundary or an SCP.
- **`ReadOnlyAccess` is not limited to calls through MCP.** IAM conditions cannot be attached to AWS managed policies, so the read permissions remain valid even if you call the API directly with the session credentials. Only the inline policy's actions and the debug role's Deny on retrieving SSM parameters are restricted by `aws:CalledViaAWSMCP`.
- In production, narrow `Resource` to specific ARNs, tags, or SSM documents, and always enable session logs (SSM Session Manager logs, ECS Exec logs, Lambda CloudWatch Logs). CloudTrail alone is not enough.
- Users are separated per role by `AllowedSubjects` (read-only) and `DebugAllowedSubjects` (debug). Keep `DebugAllowedSubjects` narrower than the read-only list.

### Cloudflare side (once)

```
mise run keygen          # Generate the signing key (.secrets/, not overwritten if it exists)
# Set AWSBRIDGE_ISSUER / AWSBRIDGE_ACCESS_* and others in mise.local.toml
cp config/profiles.example.json config/profiles.json   # The profile list (gitignored). Write the role ARNs
mise run deploy:worker   # Runs wrangler deploy → secrets in order (does not call AWS)
```

`secrets` can also be run on its own (`mise run secrets`). It passes JSON to `wrangler secret bulk` via standard input, so values do not appear in command-line arguments. What it registers is `SIGNING_JWK` / `ADDITIONAL_PUBLIC_JWKS` (for signing key rotation. Normally `[]`) / `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`. The profile list is not a secret (a Workers environment variable is limited to 5 KB each, and 270 profiles take about 38 KB). It is bundled into the Worker as `config/profiles.json` (see "Multi-account").

Verification: `mise run poc:sts` (1 positive + 4 negative cases. It calls real AWS, so use it only when you run it explicitly).

### Variables in `mise.local.toml`

Fixed defaults are in `mise.toml`. Account-specific values go in `mise.local.toml` (gitignored). All values are placeholders.

```toml
[env]
AWSBRIDGE_ISSUER = "https://awsbridge.example.workers.dev"   # The Worker's URL (OIDC issuer)
AWSBRIDGE_ALLOWED_SUBJECTS = "user@example.com,*@example.org" # Users who can assume the read-only role (comma-separated)
AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS = "admin@example.com"       # Users who can assume the debug role (comma-separated)
# AWSBRIDGE_READONLY_ROLE_NAME = "FederatedMcpReadOnly"      # Optional. Role name (default value)
# AWSBRIDGE_DEBUG_ROLE_NAME = "FederatedMcpDebug"            # Optional. Role name (default value)
# AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS = "arn:aws:iam::<account-id>:policy/<name>" # Optional. Additional managed policies for the debug role (comma-separated)
AWSBRIDGE_POC_SUBJECT = "user@example.com"                   # The user used in the positive case of poc:sts
AWSBRIDGE_ACCESS_TEAM_DOMAIN = "https://team.example.cloudflareaccess.com" # The Access team domain
AWSBRIDGE_ACCESS_AUD = "<AUD tag of the Access application>"   # The AUD of this application
```

Format of `AWSBRIDGE_ALLOWED_SUBJECTS` and `AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS` (the same for both): each element takes the form `user@example.com` or `*@example.com`. A wildcard can be used only in the local part of the email; the domain part (`*@*` or `*@*.com`) and a bare `*` are not allowed (they would permit everyone). Empty elements and leading or trailing whitespace are also errors. Emails are normalized to lowercase before matching (the Worker lowercases the Access JWT's email before passing it to STS, and `deploy:aws` also lowercases these values before passing them to CloudFormation). `deploy:aws` validates this before calling AWS, and the CloudFormation template performs the same check with `AllowedPattern`.

The managed policies attached with `AWSBRIDGE_DEBUG_ADDITIONAL_POLICY_ARNS` become exactly the operations that a user who assumes the debug role can perform. Attach only the minimum necessary permissions (nothing is attached if unset).

Overridable defaults (filled in on the `scripts/` side. Can be changed with environment variables, `mise.local.toml`, or a downstream mise config file): `AWS_PROFILE` (`awsbridge`), `AWSBRIDGE_AUDIENCE` (`awsbridge`), `AWSBRIDGE_STACK_NAME` (`awsbridge`), `AWSBRIDGE_KEY_FILE` (`.secrets/dev-signing-key.json` at the repository root), `AWSBRIDGE_NEXT_KEY_FILE` / `AWSBRIDGE_PREVIOUS_KEY_FILE` (for key rotation. By default, `.next` / `.previous` is added before the extension of `AWSBRIDGE_KEY_FILE`), `AWSBRIDGE_WRANGLER_CONFIG` (`wrangler.jsonc`), `AWSBRIDGE_WRANGLER_ENV` (`dev` if unset. **If it is an empty string, `--env` is not added**).

### Worker configuration

Secrets (registered by `mise run secrets`): `SIGNING_JWK`, `ADDITIONAL_PUBLIC_JWKS` (optional. Additional public keys for signing key rotation), `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`. The profile list is passed not as an env var or secret but as a bundled JSON module (`awsbridge:profiles`; required).

Vars (optional. Only when overriding the defaults): `ISSUER` (set with `--var` at deploy time), `IDENTITY_CLAIM` (default `email`), `ACCESS_MAX_TOKEN_AGE_SECONDS`, `STS_AUDIENCE` (default `awsbridge`), `STS_REGION` (default `us-east-1`), `STS_ENDPOINT`, `AWS_MCP_REGION` (default `us-east-1`), `AWS_MCP_ENDPOINT`, `TARGET_AWS_REGION` (default `ap-northeast-1`), `ALLOWED_ORIGINS` (comma-separated exact-match origins. Empty by default).

As a CSRF countermeasure, `/mcp` rejects requests that carry an `Origin` header (that is, requests from a browser) with 403 `forbidden_origin` unless the origin is included in `ALLOWED_ORIGINS`. Server-to-server traffic from MCP clients and the Portal, which have no `Origin`, passes through. A POST is accepted only when `Content-Type` is `application/json` (parameters such as `; charset=utf-8` are allowed); anything else (including a missing Content-Type) results in 415 `unsupported_media_type`. Access verifies the browser's cookie and injects `Cf-Access-Jwt-Assertion`, so authentication alone cannot prevent CSRF.

Errors from `/mcp` are returned as `{"error":"<code>"}`: `unauthorized` (401), `forbidden` (403. No permission to assume the role), `upstream_auth_failed` (502. Server-side configuration inconsistency), `temporarily_unavailable` (503), `server_misconfigured` (500), `unknown_aws_profile` / `invalid_aws_profile` / `batch_not_supported` (400). For a table of responses by cause, see the section on the error to HTTP status mapping in `docs/specs/architecture.md`.

## Signing key rotation

This is the procedure for replacing the Worker's signing key (secret `SIGNING_JWK`) without downtime. STS caches the JWKS, so simply swapping the key would make verification fail right after the switch. Therefore, the new key's public key is first published in the JWKS (`/.well-known/jwks.json`), and signing is switched only after STS has picked it up.

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

## Multi-account

You can switch between multiple AWS accounts with the `aws_profile` argument of MCP `tools/call`. The Worker directly assumes the selected account's role with AssumeRoleWithWebIdentity (no chaining). Who can use which account is determined by each account's trust policy (`AllowedSubjects` / `DebugAllowedSubjects`), and anything not permitted results in 403 `forbidden`.

1. For each target account, run `AWS_PROFILE=<target> mise run deploy:aws` and note the outputs `ReadOnlyRoleArn` / `DebugRoleArn`.
2. Write the profile list (required) in a JSON file. For the upstream's own development deployment, create it with `cp config/profiles.example.json config/profiles.json` (gitignored; values are placeholders). The list is not an environment variable: wrangler's `alias` bundles it into the Worker as the JSON module `awsbridge:profiles`, so there is practically no limit on the number of profiles (a Workers environment variable is limited to 5 KB each). Without the file, the build (`wrangler deploy` / `wrangler dev`) fails with `Cannot find module`. Writing `profiles` as an array is recommended. The order of the array becomes the order of the list returned by `list_aws_profiles` as-is (`default` is always first).

```json
{
  "default": "dev-readonly",
  "profiles": [
    { "name": "dev-readonly",  "roleArn": "arn:aws:iam::111111111111:role/FederatedMcpReadOnly", "description": "development (read-only)" },
    { "name": "dev-debug",     "roleArn": "arn:aws:iam::111111111111:role/FederatedMcpDebug", "description": "development (debug)" },
    { "name": "prod-readonly", "roleArn": "arn:aws:iam::222222222222:role/FederatedMcpReadOnly" },
    { "name": "prod-debug",    "roleArn": "arn:aws:iam::222222222222:role/FederatedMcpDebug" }
  ]
}
```

`profiles` can also be written as an object (`"profiles": { "dev-readonly": { "roleArn": "..." }, ... }`; the legacy format). However, the order of object keys is sometimes not preserved along the path to the Worker (the cause is unidentified. In a real environment, there was a case where `dev-readonly` → `dev-debug` was written but the Portal's enum ended up in name order). If you intend a particular order, write it as an array. In the array format, `name` is required, and duplicates result in 500 `server_misconfigured`.

- Profile names: 1 to 32 characters of alphanumerics, `_`, and `-` (exceeding that results in 500 `server_misconfigured`). Names consisting only of digits are ordered first in numeric order by the rules for objects, so avoid them if you intend a particular order.
- `default`: required. The profile used when `aws_profile` is omitted, and for requests other than `tools/call` such as `tools/list`.
- `tools`: optional. The tools that `aws_profile` applies to (all tools if omitted; omitting is normally fine). The names are the actual tool names returned by the AWS MCP Server (for example `aws___run_script`; you can check them with `tools/list`), and if you write a name that does not exist, `aws_profile` has no effect. An `aws_profile` attached to a tool that is not a target is ignored and removed.
- In the `tools/list` response, `inputSchema.properties.aws_profile` (`{type: "string", description}`; no `enum`, and the description contains neither the default nor any profile name) is injected into the target tools, and a `list_aws_profiles` tool is added (not on the second and later pages of a paginated `tools/list`). Clients (such as Claude) get the available profiles at run time by calling `list_aws_profiles`, which the Worker answers by itself after authentication (it returns `{default, profiles: [{name, description?}]}`, never a `roleArn`). Because the injected schema does not depend on the profile list, adding a profile needs neither a re-sync of the MCP Server Portal nor a reconnection of claude.ai. A re-sync and reconnection are needed only when the upstream tool set changes or when an awsbridge update changes the injected schema (including the first time you take in the update that removed the `enum` and added `list_aws_profiles`). Tools whose upstream definition already has `aws_profile` are not injected. If the response cannot be processed, it is returned as is.
- `aws_profile` is removed before being sent upstream. For a single `tools/call`, a name not in the list (`unknown_aws_profile`) or a non-string (`invalid_aws_profile`) is returned as HTTP 200 with a JSON-RPC result `isError: true` whose text contains the error code, the available profile names, and the default, so the client can correct it in one try. In a JSON-RPC batch, it results in 400 with `{"error": "<code>"}`.
- For a JSON-RPC batch, if the `aws_profile` of all target tools is the same (omitted means `default`), it is relayed with that role; if they differ, it results in 400 `batch_not_supported`.
- If the list is invalid (a format error, a duplicate, empty, and so on), the result is 500 `server_misconfigured` (the log shows only `config: invalid profiles: <kind>`, never the values). Unset makes the build fail.
- The STS `RoleSessionName` is `gw-<user>-<profile name>` (so you can tell them apart in CloudTrail).

A downstream repository does not edit the upstream `wrangler.jsonc`; its own `wrangler.<name>.jsonc` points `alias` at its own JSON (for example `deploy/profiles.json`) (see "Operating in a downstream repository"). For details, see the section on multi-account (aws_profile) in `docs/specs/architecture.md`.

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

## Setup skill (Claude Code)

A Claude Code skill that interactively sets up a downstream private repository is bundled in `.claude/skills/setup-downstream/`. You can use it as is just by cloning awsbridge (on first use you will be asked to trust the folder).

```
git clone https://github.com/youyo/awsbridge <downstream repository name>
cd <downstream repository name> && claude
/setup-downstream <downstream repository name>
```

The skill guides you in order through re-pointing the remotes (`origin` → `upstream`), creating the downstream repository, deploying the Worker, CloudFormation, Cloudflare Access/Portal, and verification. For operations that affect external systems, it asks for confirmation before running at each stage. The skill is version-controlled together with the code, so updates reach the downstream repository through `git pull --no-rebase upstream main`.

## Operating in a downstream repository

Production use is expected to happen in a private downstream repository. You register awsbridge as `upstream` and keep pulling updates. **You never edit upstream files; you only add new files** to deploy to your own environment (so `git pull` does not conflict). In the following, `<name>` is the environment name (for example `awsbridge-mcp`).

1. Create the downstream repository and bring in the upstream.

```
git clone <awsbridge URL> my-awsbridge && cd my-awsbridge
git remote rename origin upstream
git remote add origin <private repository URL>   # The downstream push destination
```

2. Add `wrangler.<name>.jsonc` (commit it. Role ARNs are not secrets). Keep `main` and the others the same as the upstream `wrangler.jsonc`, and customize only `name` / `workers_dev` / `alias`. `alias` replaces the module `awsbridge:profiles` with your profile list JSON (`deploy/profiles.json`, created right after step 2). Do not use the env section (the values are dummies).

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "awsbridge-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-21",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "workers_dev": true,
  "alias": { "awsbridge:profiles": "./deploy/profiles.json" }
}
```

   The format of `deploy/profiles.json` is the same as the JSON in "Multi-account" above (commit it. Role ARNs are not secrets). Copying the upstream `config/profiles.example.json` and rewriting it is the quickest way.

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
```

```toml
# .miserc.toml
env = ["awsbridge-mcp"]
```

4. Write secret values and environment-specific values in `mise.local.toml` (gitignored. Do not commit it): `AWSBRIDGE_ISSUER` (the Worker's URL), `AWSBRIDGE_ALLOWED_SUBJECTS`, `AWSBRIDGE_DEBUG_ALLOWED_SUBJECTS`, `AWSBRIDGE_ACCESS_TEAM_DOMAIN`, `AWSBRIDGE_ACCESS_AUD`, and so on (see "Variables in `mise.local.toml`" above). The profile list goes in `deploy/profiles.json`, not in `mise.local.toml`.

5. Deploy (first time).

```
mise run keygen          # Generate the signing key at AWSBRIDGE_KEY_FILE
mise run deploy:worker   # Deploy the Worker with wrangler.<name>.jsonc → register secrets
AWS_PROFILE=<target> mise run deploy:aws   # Deploy CloudFormation per account, and write the outputs ReadOnlyRoleArn / DebugRoleArn into deploy/profiles.json
```

6. Pull in upstream updates.

```
git pull --no-rebase upstream main
```

Notes:

- **Keep signing keys separate per environment.** Do not reuse the same key and the same issuer as the upstream's development deployment (use a different path for `AWSBRIDGE_KEY_FILE`). You can swap keys without downtime by following the "Signing key rotation" procedure (`mise run key:prepare` → `secrets` → wait → `key:activate` → `secrets` → wait → `key:retire` → `secrets`).
- **The issuer (the Worker's URL) differs per environment**, so the CloudFormation stack that creates the IAM OIDC provider and roles is also separate per environment (use different values of `AWSBRIDGE_STACK_NAME`). When placing multiple environments in the same account, also separate the role names (`AWSBRIDGE_READONLY_ROLE_NAME` / `AWSBRIDGE_DEBUG_ROLE_NAME`).
- mise gives `mise.<name>.toml` precedence over `mise.toml`, and `mise.local.toml` precedence over `mise.<name>.toml`. `.config/mise/conf.d/*.toml` loses to `mise.toml`, so it cannot be used.
- The upstream `wrangler.jsonc` (`name: awsbridge` / `env.dev`) is for the upstream's development use. Do not use it downstream.
