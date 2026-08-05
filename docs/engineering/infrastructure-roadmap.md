# Infrastructure Roadmap

## Purpose

How to get from "everything buildable in a repository is built" to an AIOS MVP
serving a real Organization.

The remaining MVP Production Baseline gaps are items 10, 11, and 12, and none of
them is code. They need a database that keeps backups somewhere durable, a metric
backend that can evaluate an alarm, and an environment to rehearse a runbook in.
[`release-readiness.md`](release-readiness.md) records exactly where each stands.

**This document does not choose a stack.** The stack is already chosen and this
sequences it. Where something genuinely is undecided, it is listed as a decision
with the options and the trade, not silently picked.

---

## What is already decided

| Concern | Decision | Where |
|---|---|---|
| Cloud | AWS | [`tech-stack.md`](tech-stack.md) |
| Region | `ap-northeast-1` (Tokyo) | [ADR-0003](../adr/0003-select-mvp-observability-stack.md) |
| Services | ECS, RDS, S3, CloudFront | [`tech-stack.md`](tech-stack.md) |
| Logs | JSON on stdout → CloudWatch Logs; Logs Insights for queries | ADR-0003 |
| Metrics | CloudWatch custom metrics, ≤100 series, no tenant identifiers | ADR-0003, [ADR-0024](../adr/0024-bound-metrics-at-the-call-site.md) |
| Alerts | CloudWatch Alarms → SNS → verified operator email | ADR-0003 |
| Control-plane audit | CloudTrail | ADR-0003 |
| Traces | Propagation only; no remote backend in the MVP | ADR-0003 |
| Database | PostgreSQL | [ADR-0006](../adr/0006-use-postgresql-transactional-outbox.md) |
| Authentication | Clerk, authentication only | [ADR-0013](../adr/0013-bind-clerk-as-authentication-provider.md) |
| Model provider | Anthropic, called directly | [ADR-0016](../adr/0016-bind-anthropic-as-the-model-provider.md) |
| RPO / RTO | ≤ 15 min / ≤ 4 h; async workflows ≤ 8 h | `observability-and-operations.md` |

Prometheus, Grafana, a Collector fleet, and an error-tracking SaaS are explicitly
**not** part of the MVP. Adding one is an ADR, not a preference.

---

## Decisions that are genuinely open

These block specific phases and only a human can settle them.

| # | Decision | Options | What turns on it |
|---|---|---|---|
| D1 | ECS launch type | **Fargate** (no hosts to patch, higher per-vCPU cost) or EC2 (cheaper at steady load, you own the AMI and patching) | Phase 3. Fargate is the smaller operational surface for a two-service MVP |
| D2 | RDS engine | **RDS for PostgreSQL** or Aurora PostgreSQL | Phase 2. Both give PITR; Aurora costs more and buys failover speed and storage elasticity the MVP has no requirement for |
| D3 | Multi-AZ at launch | Yes / no | Phase 2. Single-AZ halves the database bill and makes an AZ failure an RTO event rather than a blip. The 4-hour RTO permits single-AZ |
| D4 | Who approves the RPO and RTO | A named person | The figures exist in the architecture; the baseline requires an **owner** to accept them, which is a signature rather than a number |
| D5 | Staging fidelity | Full-size / scaled-down / ephemeral | Phase 5. Scaled-down is the usual answer and it means the runbooks' latency and failover steps stay unrehearsed at production size |
| D6 | Clerk profile webhook | In scope / out | `.env.example` implies in and no endpoint exists. Either build it or remove the variable |

---

## Phase 0 — Prove the container (no AWS, no cost) — **done**

Both images build, both start, and CI now does it on every push
(run `115`, 2026-08-05). Two things came out of it that are worth keeping.

**The `Dockerfile` had never been built** — this container cannot reach a
registry — and it built first time. `docker build --target api` takes about 45
seconds; the Worker target is effectively free because it shares the `build`
stage. Both start and fail correctly with no `DATABASE_URL`, which is what
exercises the workspace packaging split where production resolves to `dist` and
development to `src`.

**CI had never run on this branch at all.** `ci.yml` triggered on `push` to
`main` and on `pull_request`; a long-lived working branch is neither. Every check
in it had passed only where someone ran it by hand. `docs.yml` — which holds
`check_docs.py`, `check_routes.py`, and `check_audit.py`, the three checks that
catch documentation drifting from code — had the same trigger and its first run
ever was after the fix. Both now include `claude/**`.

That is the Phase 0 lesson generalised: a check that does not run is not a check,
and the same question is worth asking of every alarm added in Phase 4.

### What it looked like, for reference

The PostgreSQL service-container log is unexpectedly good evidence. Every
deliberate negative test fired on a real runner: `ck_workflow_health_status`
refusing the renamed `Critical`, the composite foreign key refusing a
cross-Organization Membership, `ck_worker_pause_type` refusing
`ConsumerDelivery`, and the migration runner refusing an edited applied
migration. Those are the constraints the design leans on, confirmed somewhere
other than the machine that wrote them.

### The original note, kept because it is still the reason

**The `Dockerfile` has never been built.** It was written with three targets and a
direct `CMD ["node", "dist/main.js"]` — deliberately not `pnpm exec`, because a
wrapper at PID 1 swallows `SIGTERM` and the Worker's graceful drain depends on
receiving it. None of that has been executed, because this container cannot reach
a registry.

Everything below deploys a container image. Building one that has never been
built, on the day you also introduce AWS, means debugging two unknowns at once.

**Do first, anywhere with a working Docker daemon:**

```bash
docker build --target api    -t aios-api:local .
docker build --target worker -t aios-worker:local .
docker compose up            # or run both against a local PostgreSQL
```

Then check the things only a real container shows:

- `node dist/main.js` starts — the workspace packaging fix means production reads
  `dist` while development reads `src`, and only a built image exercises the first
- `SIGTERM` reaches the Worker and the in-flight drain finishes before exit
- the probe ports answer from outside the container (`3011` API, `3012` Worker)
- the image size and the migration entrypoint behave

**Unblocks:** every later phase.
**I can:** fix whatever the build reveals, and add a CI job that builds both
targets on every push so it cannot rot again.

---

## Phase 1 — Account and guardrails (~1 day, ~$0)

Nothing here serves traffic. It is the part that is painful to retrofit.

1. **AWS account**, or a dedicated account in an existing Organization. One
   account per environment is the cleanest blast radius; two accounts (staging,
   production) is the minimum worth doing.
2. **Region `ap-northeast-1`**, per ADR-0003. Everything — logs, metrics, alarms,
   SNS topics, KMS keys — stays there.
3. **CloudTrail on**, per ADR-0003, covering "changes to telemetry resources, IAM
   policy, alarms, log groups, and retention configuration". Turning it on after
   an incident does not produce the trail you wanted.
4. **A budget alarm** before anything can cost money. Not in the baseline; it is
   the cheapest way to find out you left something running.
5. **An IAM role for deployment** with no long-lived keys — GitHub Actions OIDC
   into a role is the shape, and it means no AWS secret ever exists in the repo.

**Decisions:** none blocking.
**I can:** write the OIDC trust policy and the deployment role, and the CI
workflow that assumes it.

---

## Phase 2 — The data tier (~1 day, closes most of item 10)

This is the highest-value phase and it is worth doing before compute. Item 10 is
the only *Absent* baseline item whose absence risks losing customer data.

**Most of item 10 is a checkbox on RDS.** The baseline asks for continuous WAL
archiving, a base backup at least every 24 hours, and a 14-day PITR window. RDS
automated backups give all three:

```
Backup retention period: 14 days      → the PITR window
Automated backups: enabled            → continuous WAL archiving + daily snapshot
Deletion protection: on
Storage encryption: on (KMS)
```

What RDS does **not** give you, and the baseline still requires:

| Requirement | What to do |
|---|---|
| A monthly *verified* restore test | Schedule `scripts/restore_drill.sh`'s real equivalent: restore to a new instance at a chosen timestamp, assert, tear down. "Backup-job success is not proof of recoverability" |
| Deletion-resistant storage | Backups live in the same account as the thing being backed up. A copy to a separate account or a Vault Lock is what survives a compromised credential |
| The nine recovery metrics | `latest_restorable_point_age_seconds`, `restore_test_age_seconds`, and the rest — publishable now from `RDS DescribeDBInstances` plus the drill's own result |
| The RPO alarm | "Operations MUST alert before the 15-minute RPO is consumed" |

Also here:

- **S3** for restore-drill artifacts and any exported evidence.
- **Secrets Manager** for `DATABASE_URL`, `CLERK_SECRET_KEY`, `ANTHROPIC_API_KEY`.
  Not SSM plain parameters, and never a task-definition environment variable —
  those show in the console and in `DescribeTaskDefinition`.
- **A private subnet.** The database takes no public address; only the ECS tasks
  reach it.

**Decisions:** D2 (engine), D3 (Multi-AZ), D4 (RPO/RTO owner).
**I can:** write the restore-drill job against a real RDS snapshot, publish the
nine recovery metrics through the exporter that already exists, and write the
CloudWatch alarm definitions.

**Rough cost:** `db.t4g.small`, single-AZ, 14-day retention ≈ **$40–60/month** in
Tokyo. Multi-AZ roughly doubles it.

---

## Phase 3 — Compute (~2 days, makes everything real)

Two services, because the Worker is already a separate process and
`chooseWorkerMode` refuses to drain in-process outside development.

```
ECS cluster
├── service: aios-api      → ALB target group, health check GET :3011/health/ready
└── service: aios-worker   → no load balancer, health check GET :3012/health/ready
```

Points where this application has an opinion, and getting them wrong wastes a day:

- **The probe paths are `/health/live` and `/health/ready`**, not `/livez`. They
  are on a *separate port* from the application, deliberately, so an exhausted
  request pool cannot stop the probe answering.
- **Readiness gates traffic; liveness gates restarts.** Wiring the ALB to
  `/health/live` would keep sending traffic to a process that cannot reach the
  database. Wiring the restart check to `/health/ready` turns a thirty-second
  database blip into every task restarting at once.
- **The Worker needs a termination grace period longer than its longest drain.**
  It finishes the batch in flight on `SIGTERM`; killed early, claimed messages
  wait for their lease to expire instead.
- **Migrations run once per deploy, before the new tasks start**, as a one-off
  ECS task. Never on application start: two tasks starting together would race,
  and ADR-0020's ledger would refuse the second one loudly rather than quietly,
  which is better but still an outage.
- **`WORKER_PAUSED_TYPES` is read at startup** — pausing globally is a task
  restart, which is what runbook 8 says.

Also: ALB with ACM certificate, CloudFront for the web client, and the API's
`WEB_ORIGIN` set to the real origin.

**Decisions:** D1 (launch type).
**I can:** write the task definitions, the ECS service definitions, the
migration task, and the deploy workflow.

**Rough cost:** two Fargate tasks at 0.5 vCPU / 1 GB ≈ **$35/month** each, ALB
≈ **$25/month**. Call it **$100/month** for compute and networking.

---

## Phase 4 — Telemetry and alerts (~2 days, closes item 11)

Logs arrive free: the application already writes JSON to stdout and the ECS
`awslogs` driver ingests it. Set the retention on each log group to ADR-0003's
table — 30 days for application and Worker logs, 90 for restricted security logs,
365 for Class A and B audit (which lives in PostgreSQL, not CloudWatch).

**Metrics need one thing in code that is not built: the CloudWatch transport.**
[ADR-0024](../adr/0024-bound-metrics-at-the-call-site.md) built every bound
between the call site and the network and stopped there, deliberately — the
bounds are the feature and a transport is an afternoon. `METRICS_SINK=cloudwatch`
is already accepted and says in the startup log that its transport is unbuilt.

Then the alarms item 11 requires, each with an SNS topic behind it:

| Alert | Fires on |
|---|---|
| Database unavailable | `httpReadiness` reason `DATABASE_UNAVAILABLE`, or RDS's own metric |
| Authoritative write failure | `http_server_requests_total{outcome_class="5xx"}` rate |
| Outbox or Worker stopped | `outbox_oldest_pending_age_seconds`, `worker_jobs_completed_total` flat |
| Memory-generation failure | `memory_generation_failed_total` |
| Organization-isolation violation | An audit row with `outcome='Deny'` and a cross-Organization reason code — a **metric filter on the log group**, since the metric backend must never see the Organization |

The last one is the shape of every tenant-sensitive alert: the *count* goes to
CloudWatch, the *identifiers* stay in PostgreSQL and the logs, and the alarm
notification carries "a protected internal reference that an authorized operator
resolves through the Operations Application Service" rather than a tenant name.

**Decisions:** who receives the SNS email, and what "actionable" means for each —
an alert nobody acts on trains people to ignore the ones that matter.
**I can:** write the CloudWatch transport, the alarm definitions, the metric
filters, the dashboards, and the saved Logs Insights queries the runbooks cite.

**Rough cost:** metrics ≈ **$30/month** at a hundred series; logs depend on
volume, ≈ **$10–30/month** at MVP traffic.

---

## Phase 5 — Staging, and rehearsing the runbooks (~1 day, closes item 12)

Item 12 is *Partial* for one reason: all eight runbooks are written and executed,
but runbooks 1–5 were executed against a live **local** environment. There is no
load balancer, no replica, no object store, no second application replica, and no
real provider — so every step depending on those is unrehearsed.

A staging environment is the same Phase 1–4 stack, smaller. What it buys is the
ability to break things on purpose:

1. Stop the RDS instance → runbook 1's `DATABASE_UNAVAILABLE`, this time through
   an ALB with two tasks behind it.
2. Fail over Multi-AZ → the `DATABASE_READ_ONLY` path, against a real promotion
   rather than a session setting.
3. Deploy a deliberately broken image → runbook 5, including the mixed-version
   state that `GET /admin/diagnostics`'s `schemaVersion` exists to reveal.
4. Restore to a point in time → runbook 6, against the real object store, which
   is the number `scripts/restore_drill.sh` cannot measure: fetch time dominates
   RTO.
5. Pause a Worker type by task-definition change → runbook 8.

Record `lastTestedAt` in [`runbooks.md`](runbooks.md) after each. A runbook that
has never been run at production shape is still partly a draft.

**Decisions:** D5 (fidelity).
**Rough cost:** a scaled-down staging ≈ **$60–80/month**, or near zero if you
tear it down between exercises.

---

## Phase 6 — The two credentials (~half a day each)

Independent of everything above, and A3 is worth doing first because it is the
smallest.

**A3 — Anthropic.** Put `ANTHROPIC_API_KEY` in Secrets Manager. That is the whole
change: the generator, the groundedness harness, and the cost and rate-limit
reporting are built and have only ever run against the deterministic generator.
The first real run answers three questions nobody can answer now — what a
generation costs, whether the output is grounded, and where the rate limits bite.

**A1 — Clerk.** A production instance, then `CLERK_SECRET_KEY` or
`CLERK_JWT_KEY` in Secrets Manager. **The key is not the hard part.** `apps/web`
has no sign-in at all — it carries a development identity switcher that sets
`x-dev-subject`, and replacing it with a real session is the larger job. Verify
token verification both networkless and via JWKS; `chooseAuth` already refuses to
fall back to the development adapter outside `development` and `test`, so a
misconfiguration fails to start rather than serving unauthenticated.

Also settle D6 here: implement the profile webhook or remove the variable.

---

## The order, and why

```
Phase 0  container            ← DONE
Phase 1  account, CloudTrail  ← painful to retrofit
Phase 2  RDS, secrets, S3     ← closes most of item 10; protects data first
Phase 3  ECS, ALB, CloudFront ← first time it is reachable by a person
Phase 6  Anthropic key        ← smallest, highest information
Phase 4  CloudWatch, alarms   ← closes item 11
Phase 5  staging, rehearsal   ← closes item 12
Phase 6  Clerk + web sign-in  ← largest remaining product work
```

Data durability before compute is the one ordering that is not negotiable. Every
other phase can be reordered against your constraints; losing a customer's data
because backups came after launch cannot be undone by reordering anything.

**Total steady-state cost, production only: roughly $200–250/month.** With
staging, $270–330.

---

## What I can do without an AWS account

- Everything in Phase 0, once there is a Docker daemon.
- The CloudWatch metric transport (Phase 4), behind the bounds that already exist.
- The nine recovery metrics (Phase 2), published through the same exporter.
- Infrastructure-as-code for all of it — task definitions, service definitions,
  RDS parameters, alarms, metric filters, dashboards, the OIDC deployment role.
- The deploy workflow and the migration task.
- The saved Logs Insights queries each runbook cites.

None of it can be *applied* from here, and none of it is verified until it is.
Written-but-unapplied infrastructure has the same status as an unexecuted
runbook, and this document should not pretend otherwise.

**What I cannot do:** create any AWS resource, hold a credential, verify a
deployment, or run a failover. Those need an account and a person.
