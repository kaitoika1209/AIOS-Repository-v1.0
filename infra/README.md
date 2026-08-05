# Infrastructure

CloudFormation for the AIOS MVP, in the order
[`../docs/engineering/infrastructure-roadmap.md`](../docs/engineering/infrastructure-roadmap.md)
sequences the phases.

## None of this has been applied

There is no AWS account. Every template here was written from the roadmap and
from the code, and **not one resource has ever been created**. That places it in
the same category as an unexecuted runbook: plausible, reviewed, and unproven.

`scripts/check_infra.py` narrows the gap but does not close it. It checks the
part that is a claim about *this repository* — that an alarm threshold matches
the constant in `recovery.ts`, that the load balancer probes the path the
process actually serves, that a log group's retention is the one in ADR-0003's
table, that no secret is passed as an environment variable, that no long-lived
AWS key exists anywhere. It cannot check that CloudFormation accepts the
template, that the resources come up, or that they talk to each other.

Run `cfn-lint` and then a real `create-stack` in a throwaway account before
believing any of it.

## The stacks

| File | Phase | What it creates |
|---|---|---|
| `00-network.yaml` | 1 | VPC, two AZs, public and private subnets, one NAT gateway |
| `01-deployment-role.yaml` | 1 | GitHub OIDC provider and the deployment role |
| `02-data.yaml` | 2 | RDS PostgreSQL, KMS, Secrets Manager, locked backup vault, evidence bucket |
| `04-telemetry.yaml` | 4 | Log groups, SNS, alarms, metric filter, saved queries, dashboard |
| `03-compute.yaml` | 3 | ECR, ECS cluster, ALB, task definitions, the two services |

## Order

```
00-network  →  01-deployment-role  →  02-data  →  04-telemetry  →  03-compute
```

**04 before 03**, which is not the numbering. The log groups live in 04, and ECS
auto-creates a missing log group **with no retention at all** — indefinite
retention, which ADR-0003 prohibits, arriving by accident and discovered on a
bill or a subject access request. The numbering follows the roadmap's phases;
the deployment order follows the dependency.

`03` is also the only stack that changes on an ordinary deploy, and it does not
change through CloudFormation: the deploy workflow registers a new task
definition and rolls the services. Re-running `03` is for changing the *shape*
of the compute, not the version of it.

## Applying one

```bash
aws cloudformation deploy \
  --region ap-northeast-1 \
  --stack-name aios-staging-network \
  --template-file infra/00-network.yaml \
  --parameter-overrides EnvironmentName=staging \
  --capabilities CAPABILITY_NAMED_IAM
```

`CAPABILITY_NAMED_IAM` is needed for `01`, `02`, and `03`, which create named
roles. Naming them is deliberate: `iam:PassRole` in the deployment policy is
scoped by name, and a generated name would force that scope to a wildcard.

## Decisions this encodes, and where they came from

| Decision | Value here | Why |
|---|---|---|
| Region | `ap-northeast-1` | ADR-0003 |
| Launch type (D1) | Fargate | Smaller operational surface for two services |
| Multi-AZ (D2, D3) | RDS PostgreSQL, single-AZ by default | The 4-hour RTO permits it; `MultiAz=true` flips it |
| PITR window | 14 days, `MinValue: 14` | The baseline's floor, enforced as a stack failure rather than a preference |
| Deletion-resistant copy | Backup Vault Lock, 30–365 days | "Backups live in the same account as the thing being backed up" |
| Load-balancer health check | `/health/ready` on `:3011` | Readiness gates traffic |
| Container health check | `/health/live` | Liveness gates restarts |
| Worker stop timeout | 120s | Longer than its longest drain |
| Migrations | A one-off ECS task, before the roll | Never on application start (ADR-0020) |
| Secrets | `Secrets`, never `Environment` | `DescribeTaskDefinition` is widely readable |
| Deployment credentials | OIDC, one exact ref | No key with no expiry |

## What is deliberately not here

- **CloudFront and the web client.** `apps/web` has no real sign-in yet (A1),
  so there is nothing to serve that a person could log into. Adding the
  distribution before that would be building the front door of a house with no
  lock.
- **A second NAT gateway.** Redundancy behind a single-AZ database is redundancy
  in the wrong place. Add it with `MultiAz=true`, not before.
- **An audit log group.** Class A and Class B audit are PostgreSQL tables,
  deliberately "not placed behind an optional telemetry exporter". A CloudWatch
  copy would be a second, less durable, unowned retention path for the same
  records.
- **The Organization-isolation metric filter.** The roadmap called for one; it
  cannot exist. Authorization denials are audit rows in PostgreSQL and are never
  logged, and a cross-tenant access returns 404 by design — identical to a
  genuine miss. `authorization_denied_total` alarms on the *rate*, which is the
  probing signal; the isolation finding stays runbook 4's query against the
  audit table.
