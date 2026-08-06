# Applying Phase 1 for the first time

A step-by-step for the first person to point these templates at a real account.

Written to be read once, in order, with a terminal open. Every step says what to
check afterwards, because a stack that reports `CREATE_COMPLETE` has told you
that CloudFormation was satisfied and nothing else.

**Do staging first, completely, before touching production.** Not because
staging matters less — because the first pass is where every wrong assumption in
these templates surfaces, and you want it to surface somewhere you can delete.

---

## Before you start

### What is already verified, and what is not

| | |
|---|---|
| The templates are valid CloudFormation | **Yes** — `cfn-lint` with informational and experimental rules, clean, in CI |
| They agree with the application | **Yes** — 122 assertions in `scripts/check_infra.py`, in CI |
| They create working infrastructure | **Unknown. Nobody has ever run them.** |

The third row is the whole reason this document exists. Expect to fix things.

### Decisions you need before each phase

| # | Decision | Blocks | If you have no opinion |
|---|---|---|---|
| — | One account or two | Everything | Two: `aios-staging`, `aios-production`. Separate accounts are the only blast radius that actually holds |
| D2 | RDS engine | Phase 2 | RDS for PostgreSQL. The template says so; Aurora buys failover speed the 4-hour RTO does not need |
| D3 | Multi-AZ | Phase 2 | `false` for staging. For production it is a cost decision — roughly doubles the database bill |
| D4 | **Who signs off the RPO and RTO** | Baseline item 10 | **Nobody can decide this for you.** It is a signature, not a number. The figures already exist; the baseline requires an owner to accept them |
| D1 | ECS launch type | Phase 3 | Fargate. The template says so |
| D5 | Staging fidelity | Phase 5 | Scaled down; tear it down between exercises |
| D6 | Clerk profile webhook | Phase 6 | Still open. `.env.example` names a signing secret with no endpoint behind it |

Only **D4** genuinely blocks anything in Phase 1, and it blocks a *checkbox*
rather than a command. Start applying; settle it before you call item 10 done.

### What you need installed

```bash
aws --version          # v2
cfn-lint --version     # optional locally; CI runs it either way
```

---

## Step 0 — The account, and the two things that are painful to retrofit

1. **Create the account** (or a dedicated account in an existing Organization).
2. **Set the Region to `ap-northeast-1`** and keep everything there. ADR-0003
   pins it; the application refuses to guess it.
3. **Turn on CloudTrail** before anything else exists. ADR-0003 requires it to
   cover "changes to telemetry resources, IAM policy, alarms, log groups, and
   retention configuration". Turning it on after an incident does not produce
   the trail you wanted.
4. **Set a budget alarm.** Not in the baseline. It is the cheapest way to find
   out you left something running, and this stack's steady state is $200–250 a
   month with nothing serving traffic.
5. **Enable MFA on the root user and then stop using it.**

```bash
export AWS_REGION=ap-northeast-1
aws sts get-caller-identity     # confirm which account you are in, every time
```

That last command is worth a habit. Every destructive step below is destructive
in whichever account is currently configured.

---

## Step 1 — The network

```bash
aws cloudformation deploy \
  --stack-name aios-staging-network \
  --template-file infra/00-network.yaml \
  --parameter-overrides EnvironmentName=staging
```

**Check:** the VPC exists, and `aws cloudformation list-exports` shows
`aios-staging-vpc`, `-public-subnets`, `-private-subnets`. Every later stack
imports those three names; a typo here surfaces two stacks later as
"No export named …".

**Cost from this moment:** the NAT gateway, about $45/month, whether or not
anything uses it. It is the first thing to delete if you pause the work.

---

## Step 2 — The deployment identity

```bash
aws cloudformation deploy \
  --stack-name aios-deployment-role \
  --template-file infra/01-deployment-role.yaml \
  --parameter-overrides \
      GitHubRepository=kaitoika1209/AIOS-Repository-v1.0 \
      DeployRef=refs/heads/main \
  --capabilities CAPABILITY_NAMED_IAM
```

**If the account already has a GitHub OIDC provider**, this fails with
`EntityAlreadyExists`. Delete the `GitHubOidcProvider` resource from the
template and reference the existing ARN instead — you cannot have two.

**Check the trust policy by reading it, not by trusting the template:**

```bash
aws iam get-role --role-name aios-deployment \
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition'
```

The `sub` must be exactly `repo:<owner>/<name>:ref:refs/heads/main`. **If it
contains a `*`, stop.** That would let any workflow in the repository — including
one running from a stranger's pull request — obtain deployment credentials. The
parameters carry `AllowedPattern`s that refuse a wildcard, so this should be
impossible; check anyway, because that guard was added *after* a check that
looked correct and was not.

Then put the role ARN in GitHub as a **variable, not a secret** — it is an
identifier, not a credential:

```
Settings → Secrets and variables → Actions → Variables → AWS_DEPLOY_ROLE_ARN
```

**Do not create an access key.** If you find yourself wanting one, something
above went wrong.

---

## Step 3 — The data tier

This is the phase worth slowing down for. Item 10 is the only *Absent* baseline
item whose absence risks losing customer data, and data durability before
compute is the one ordering that is not negotiable.

```bash
aws cloudformation deploy \
  --stack-name aios-staging-data \
  --template-file infra/02-data.yaml \
  --parameter-overrides EnvironmentName=staging MultiAz=false \
  --capabilities CAPABILITY_NAMED_IAM
```

Takes 10–20 minutes; RDS is slow to create.

### Then check the four things RDS does not tell you it is doing

```bash
aws rds describe-db-instances --db-instance-identifier aios-staging \
  --query 'DBInstances[0].{
      retention: BackupRetentionPeriod,
      encrypted: StorageEncrypted,
      public: PubliclyAccessible,
      restorable: LatestRestorableTime }'
```

- `retention` must be **14** or more. The template sets `MinValue: 14` so a
  smaller value fails the stack rather than reducing the window quietly.
- `encrypted` must be `true`.
- `public` must be `false`.
- `restorable` is the field the RPO is measured against. It appears a few
  minutes after creation; until it does, `latest_restorable_point_age_seconds`
  is genuinely unknown and the Worker will withhold it rather than publish zero.

### Put the secrets in

RDS creates the database credential itself (`MasterUserSecret`). The other two
are yours:

```bash
aws secretsmanager put-secret-value --secret-id aios/staging/clerk \
  --secret-string '{"CLERK_SECRET_KEY":"…","CLERK_WEBHOOK_SIGNING_SECRET":"…"}'

aws secretsmanager put-secret-value --secret-id aios/staging/anthropic \
  --secret-string '{"ANTHROPIC_API_KEY":"…"}'
```

**Type these into a terminal, not into a file, a chat, or a commit.** A key that
has been written down somewhere it can be read later is a key to rotate.

The task definitions reference these by `secret-arn:KEY::`, so the JSON key
names above must match exactly. A mismatch appears as a task that fails to start
with `ResourceInitializationError`, which does not say which key it wanted.

### `DATABASE_URL` is written by hand, once

RDS's managed master password is a JSON document of `username` and `password` —
**not** a connection string — so nothing can read `DATABASE_URL` out of it. The
stack therefore creates an empty `aios/<env>/database-url` secret, and you fill
it in after the instance exists, because the endpoint is not known until then
and the managed password is deliberately not readable from a template.

```bash
ENDPOINT=$(aws cloudformation list-exports \
  --query "Exports[?Name=='aios-staging-db-endpoint'].Value" --output text)

MASTER=$(aws cloudformation list-exports \
  --query "Exports[?Name=='aios-staging-db-master-secret'].Value" --output text)
PASSWORD=$(aws secretsmanager get-secret-value --secret-id "$MASTER" \
  --query SecretString --output text | python3 -c 'import json,sys;print(json.load(sys.stdin)["password"])')

aws secretsmanager put-secret-value --secret-id aios/staging/database-url \
  --secret-string "{\"DATABASE_URL\":\"postgresql://aios:$PASSWORD@$ENDPOINT:5432/aios\"}"
unset PASSWORD
```

This one was found by reading the templates against each other before applying
them — the task definition asked for a key the secret would never have, and the
failure would have appeared as a task that never starts with
`ResourceInitializationError`, which does not say which key it wanted.

**When you rotate the master password, this secret does not follow.** That is a
real operational edge and there is no automation for it yet; rewrite it with the
same command.

---

## Step 4 — Telemetry, *before* compute

Yes, 04 before 03. ECS auto-creates a missing log group **with no retention at
all**, and ADR-0003 prohibits exactly that. Creating them first is the only way
the retention table is true from the first task.

```bash
aws cloudformation deploy \
  --stack-name aios-staging-telemetry \
  --template-file infra/04-telemetry.yaml \
  --parameter-overrides EnvironmentName=staging AlertEmail=you@example.com
```

**Confirm the SNS subscription from your inbox.** An unconfirmed subscription
drops every alert silently, and an alarm nobody receives is worse than no alarm
— it looks like coverage.

```bash
aws sns list-subscriptions-by-topic \
  --topic-arn $(aws cloudformation list-exports \
    --query "Exports[?Name=='aios-staging-alerts'].Value" --output text)
```

`SubscriptionArn` must not read `PendingConfirmation`.

**Then check the retentions**, because this is the one ADR-0003 states as a
prohibition rather than a preference:

```bash
aws logs describe-log-groups --log-group-name-prefix /aios/staging \
  --query 'logGroups[].{name:logGroupName, days:retentionInDays}' --output table
```

30 for api, worker, migrate; 90 for security. **Any `null` is a log group
retained forever**, which is the prohibited configuration.

---

## Step 5 — Compute

You need an image and a certificate first.

```bash
# The certificate, in the same Region as the load balancer.
aws acm request-certificate --domain-name api.staging.example.com \
  --validation-method DNS
# …then add the CNAME it asks for, and wait for ISSUED.

# The first image, pushed by hand. After this the deploy workflow does it.
aws ecr get-login-password | docker login --username AWS \
  --password-stdin "$(aws sts get-caller-identity --query Account --output text).dkr.ecr.ap-northeast-1.amazonaws.com"
docker build --target api -t "$REGISTRY/aios-staging:$(git rev-parse HEAD)" .
docker push "$REGISTRY/aios-staging:$(git rev-parse HEAD)"
```

The registry is created by the compute stack, so this is a chicken-and-egg
order: deploy `03-compute.yaml` once (it will fail to place tasks because the
image does not exist), push the image, then update the stack. Or create the ECR
repository by hand first.

```bash
aws cloudformation deploy \
  --stack-name aios-staging-compute \
  --template-file infra/03-compute.yaml \
  --parameter-overrides \
      EnvironmentName=staging \
      ImageTag=$(git rev-parse HEAD) \
      CertificateArn=arn:aws:acm:… \
      WebOrigin=https://staging.example.com \
  --capabilities CAPABILITY_NAMED_IAM
```

### Run the migration before you expect anything to work

The services will not become healthy against an unmigrated database: readiness
reports `MIGRATIONS_PENDING` and the target group refuses to route. That is the
design working, and it is also what it looks like when you have forgotten this
step.

```bash
aws ecs run-task --cluster aios-staging \
  --task-definition aios-staging-migrate \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[…],securityGroups=[…],assignPublicIp=DISABLED}"
```

### What to check, in this order

```bash
# 1. Are the tasks running at all?
aws ecs describe-services --cluster aios-staging \
  --services aios-staging-api aios-staging-worker \
  --query 'services[].{name:serviceName,running:runningCount,desired:desiredCount}'

# 2. If they are running but not healthy, ask the application why.
aws logs tail /aios/staging/api --since 10m --format short | grep -E 'readiness|start_failed'

# 3. Is the load balancer routing?
aws elbv2 describe-target-health --target-group-arn …
```

The `reasonCode` in the readiness response names the failure precisely —
`DATABASE_UNAVAILABLE`, `MIGRATIONS_PENDING`, `DATABASE_READ_ONLY`,
`PROBE_TIMEOUT`. Read it before guessing.

---

## Step 6 — Prove it, rather than declaring it

Three things, in this order. None takes long and each one has caught something
before.

**The metrics arrive.** The task role permits `PutMetricData` only in the `AIOS`
namespace, so an empty namespace means the transport is not running, not that
nothing happened.

```bash
aws cloudwatch list-metrics --namespace AIOS --query 'length(Metrics)'
```

**The recovery metrics are populated.** `latest_restorable_point_age_seconds`
appearing at all means the Worker reached `DescribeDBInstances`; its absence
means `RDS_DB_INSTANCE_IDENTIFIER` is unset or the task role cannot read RDS.
Both are withheld rather than published as zero, so **absence is the signal**.

**The alarms are not in `INSUFFICIENT_DATA` for the wrong reason.**

```bash
aws cloudwatch describe-alarms --alarm-name-prefix aios-staging \
  --query 'MetricAlarms[].{name:AlarmName,state:StateValue}' --output table
```

The recovery alarms are configured `TreatMissingData: breaching`, so a genuinely
missing series shows `ALARM` rather than `INSUFFICIENT_DATA`. If one of them is
`INSUFFICIENT_DATA`, that is not "no news" — check the alarm's configuration,
because the treatment is the only thing making an absent series visible.

**Then break something on purpose**, which is Phase 5 and
[`staging-rehearsal.md`](../docs/engineering/staging-rehearsal.md). Stopping the
RDS instance is the cheapest one and exercises runbook 1 through a real load
balancer with two replicas behind it.

---

## When something fails

`aws cloudformation describe-stack-events --stack-name … --max-items 20` and
read from the bottom. The first `CREATE_FAILED` is the cause; everything after
it is rollback noise.

Three that are likely here specifically:

| Symptom | Cause |
|---|---|
| `No export named aios-staging-vpc` | Step 1 did not run, or ran with a different `EnvironmentName` |
| Task stops immediately, `ResourceInitializationError` | A secret key name does not match what the task definition asks for — see the `DATABASE_URL` note in step 3 |
| Service never stabilises, tasks cycle | Readiness is failing. `aws logs tail /aios/staging/api` and read the `reasonCode` before changing anything |

**Tearing down staging:** delete the stacks in reverse order. The retained
resources — database, evidence bucket, KMS key, backup vault, secrets, log
groups, registry — stay behind on purpose and must be deleted by hand. That is
the design: a stack operation must never be able to destroy the data or the key
that decrypts it.

---

## What to bring back

Anything in this document that turned out to be wrong. These templates have
never been applied, and the first person to run them knows more about them than
the person who wrote them.
