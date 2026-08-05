#!/usr/bin/env python3
"""Check the CloudFormation templates against the code and the ADRs.

    python3 scripts/check_infra.py

None of `infra/` has been applied. It cannot be, from here — creating an AWS
resource needs an account and a person, and `infrastructure-roadmap.md` says
plainly that written-but-unapplied infrastructure has the same status as an
unexecuted runbook.

What *can* be checked is the part that is a claim about this repository. A task
definition asserts which port answers a probe; an alarm asserts that a metric
exists and that its threshold is the number the architecture states; a log group
asserts a retention from ADR-0003's table. Every one of those is checkable
against the source, and every one of them is the kind of thing that is wrong for
months because nobody re-read two files together.

So this compares:

  * alarm thresholds against the constants in `packages/application/src/recovery.ts`
  * alarm metrics and dimensions against `METRIC_CATALOGUE` and `ALLOWED_DIMENSIONS`
  * the namespace against `METRIC_NAMESPACE` in `cloudwatch-transport.ts`
  * log-group retention against ADR-0003's table
  * probe paths and ports against what `health.ts` and `probe-server.ts` serve
  * that secrets are `Secrets`, never `Environment`
  * that no long-lived AWS key appears anywhere
  * that the OIDC trust policy names a ref rather than a wildcard

It is not a substitute for `cfn-lint` or for a deployment. It catches the class
of error a syntax check cannot: a template that is valid CloudFormation and
wrong about this application.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
INFRA = ROOT / "infra"
WORKFLOWS = ROOT / ".github/workflows"

failures: list[str] = []
checks = 0


def check(condition: bool, message: str) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(message)


# --- Loading -----------------------------------------------------------------
#
# CloudFormation's short tags (`!Ref`, `!Sub`, `!GetAtt`) are YAML tags PyYAML
# does not know. Resolving them to the long form keeps the templates idiomatic
# while leaving them machine-readable here — the alternative, writing every
# intrinsic as `{"Fn::Sub": ...}`, would make the templates worse to read in
# exchange for making this script simpler, which is the wrong trade.
class CfnLoader(yaml.SafeLoader):
    pass


def _cfn_tag(loader: yaml.Loader, tag_suffix: str, node: yaml.Node):
    name = tag_suffix if tag_suffix.startswith("Fn::") or tag_suffix == "Ref" else f"Fn::{tag_suffix}"
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
        if tag_suffix == "GetAtt":
            return {"Fn::GetAtt": value.split(".")}
        return {name: value}
    if isinstance(node, yaml.SequenceNode):
        return {name: loader.construct_sequence(node, deep=True)}
    return {name: loader.construct_mapping(node, deep=True)}


CfnLoader.add_multi_constructor("!", _cfn_tag)


def load(path: Path) -> dict:
    with path.open() as handle:
        return yaml.load(handle, Loader=CfnLoader)


def resources(template: dict, kind: str) -> list[tuple[str, dict]]:
    return [
        (name, body.get("Properties", {}))
        for name, body in template.get("Resources", {}).items()
        if body.get("Type") == kind
    ]


def walk(node):
    """Every scalar in a nested structure, for the text-level assertions."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield key
            yield from walk(value)
    elif isinstance(node, list):
        for item in node:
            yield from walk(item)
    else:
        yield node


# --- What the code says ------------------------------------------------------
def read(relative: str) -> str:
    return (ROOT / relative).read_text()


def ts_number(source: str, name: str) -> int:
    """`export const NAME = 900;` and `31 * 24 * 60 * 60`, evaluated."""
    match = re.search(rf"export const {name}\s*=\s*([^;]+);", source)
    if match is None:
        raise SystemExit(f"check_infra: {name} is no longer exported; the check cannot run.")
    expression = match.group(1).replace("_", "")
    if not re.fullmatch(r"[\d\s*+()]+", expression):
        raise SystemExit(f"check_infra: {name} is no longer a numeric literal.")
    return int(eval(expression))  # noqa: S307 — the pattern above admits arithmetic only


def ts_string_list(source: str, name: str) -> list[str]:
    match = re.search(rf"export const {name} = \[(.*?)\]", source, re.S)
    if match is None:
        raise SystemExit(f"check_infra: {name} is no longer exported.")
    return re.findall(r'"([^"]+)"', match.group(1))


recovery_src = read("packages/application/src/recovery.ts")
metrics_src = read("packages/application/src/metrics.ts")
transport_src = read("apps/api/src/cloudwatch-transport.ts")

RPO_ALARM_SECONDS = ts_number(recovery_src, "RPO_ALARM_SECONDS")
RPO_SECONDS = ts_number(recovery_src, "RPO_SECONDS")
MIN_PITR_WINDOW_DAYS = ts_number(recovery_src, "MIN_PITR_WINDOW_DAYS")
RESTORE_TEST_MAX_AGE_SECONDS = ts_number(recovery_src, "RESTORE_TEST_MAX_AGE_SECONDS")
DR_EXERCISE_MAX_AGE_SECONDS = ts_number(recovery_src, "DR_EXERCISE_MAX_AGE_SECONDS")
RECOVERY_METRICS = set(ts_string_list(recovery_src, "RECOVERY_METRICS"))
ALLOWED_DIMENSIONS = set(ts_string_list(metrics_src, "ALLOWED_DIMENSIONS"))

catalogue_block = re.search(r"export const METRIC_CATALOGUE = \{(.*?)\n\} as const", metrics_src, re.S)
if catalogue_block is None:
    raise SystemExit("check_infra: METRIC_CATALOGUE is no longer a literal object.")
METRIC_CATALOGUE = set(re.findall(r"^\s{2}(\w+):", catalogue_block.group(1), re.M))

namespace_match = re.search(r'export const METRIC_NAMESPACE = "([^"]+)"', transport_src)
if namespace_match is None:
    raise SystemExit("check_infra: METRIC_NAMESPACE is no longer exported.")
METRIC_NAMESPACE = namespace_match.group(1)

# The thresholds an alarm over these metrics must carry, from the architecture
# by way of the constants above. A template that drifts from the code is the
# failure this mapping exists to catch.
EXPECTED_THRESHOLD = {
    "latest_restorable_point_age_seconds": RPO_ALARM_SECONDS,
    "pitr_window_days": MIN_PITR_WINDOW_DAYS,
    "restore_test_age_seconds": RESTORE_TEST_MAX_AGE_SECONDS,
    "disaster_recovery_exercise_age_seconds": DR_EXERCISE_MAX_AGE_SECONDS,
}

# ADR-0003's retention table.
EXPECTED_RETENTION = {
    "api": 30,
    "worker": 30,
    "migrate": 30,
    "postgresql": 30,
    "security": 90,
}

SECRET_NAMES = {
    "DATABASE_URL",
    "CLERK_SECRET_KEY",
    "CLERK_WEBHOOK_SIGNING_SECRET",
    "ANTHROPIC_API_KEY",
}

templates = sorted(INFRA.glob("*.yaml"))
check(len(templates) >= 4, "infra/ holds fewer templates than the roadmap's phases.")

loaded = {}
for path in templates:
    try:
        loaded[path.name] = load(path)
    except yaml.YAMLError as error:
        failures.append(f"{path.name}: does not parse — {error}")

# --- Log-group retention -----------------------------------------------------
#
# "CloudWatch log-group retention is set explicitly through Infrastructure as
# Code. The provider default of indefinite log retention is prohibited."
for name, template in loaded.items():
    for logical, props in resources(template, "AWS::Logs::LogGroup"):
        retention = props.get("RetentionInDays")
        check(
            retention is not None,
            f"{name}: log group {logical} sets no RetentionInDays; the provider default is indefinite, "
            "which ADR-0003 prohibits.",
        )
        group = json.dumps(props.get("LogGroupName", ""))
        for suffix, expected in EXPECTED_RETENTION.items():
            if suffix in group:
                check(
                    retention == expected,
                    f"{name}: log group {logical} keeps {retention} days; ADR-0003's table says {expected}.",
                )
                break

# --- Alarms ------------------------------------------------------------------
alarm_metrics: set[str] = set()
filter_metrics: set[str] = set()

for name, template in loaded.items():
    for logical, props in resources(template, "AWS::Logs::MetricFilter"):
        for transformation in props.get("MetricTransformations", []):
            filter_metrics.add(transformation.get("MetricName", ""))
            check(
                transformation.get("MetricNamespace") == METRIC_NAMESPACE,
                f"{name}: metric filter {logical} publishes outside the {METRIC_NAMESPACE} namespace, "
                "so it does not count against ADR-0003's series cap.",
            )

for name, template in loaded.items():
    for logical, props in resources(template, "AWS::CloudWatch::Alarm"):
        if props.get("Namespace") != METRIC_NAMESPACE:
            continue
        metric = props.get("MetricName", "")
        alarm_metrics.add(metric)

        check(
            metric in METRIC_CATALOGUE or metric in filter_metrics,
            f"{name}: alarm {logical} watches {metric!r}, which is neither in METRIC_CATALOGUE nor "
            "produced by a metric filter — it will sit in INSUFFICIENT_DATA forever.",
        )

        for dimension in props.get("Dimensions", []):
            check(
                dimension.get("Name") in ALLOWED_DIMENSIONS,
                f"{name}: alarm {logical} uses dimension {dimension.get('Name')!r}, which is not in "
                "ALLOWED_DIMENSIONS — no sample will ever carry it.",
            )

        if metric in EXPECTED_THRESHOLD:
            check(
                props.get("Threshold") == EXPECTED_THRESHOLD[metric],
                f"{name}: alarm {logical} uses threshold {props.get('Threshold')}, but "
                f"{metric} is defined as {EXPECTED_THRESHOLD[metric]} in recovery.ts.",
            )

        if metric in RECOVERY_METRICS and metric in EXPECTED_THRESHOLD:
            # The one that is easy to get wrong and impossible to notice. An
            # unknown recovery value is *withheld*, so the absence of the series
            # is the signal; with the default treatment the alarm never leaves
            # INSUFFICIENT_DATA on exactly the cluster it exists to catch.
            check(
                props.get("TreatMissingData") == "breaching",
                f"{name}: alarm {logical} watches the recovery metric {metric} without "
                "TreatMissingData: breaching, so an unknown value silences it.",
            )

check(
    RPO_ALARM_SECONDS < RPO_SECONDS,
    "recovery.ts: the RPO alarm fires at or after the objective is consumed; "
    "'Operations MUST alert BEFORE the 15-minute RPO is consumed'.",
)

# --- Probes ------------------------------------------------------------------
#
# Readiness gates traffic; liveness gates restarts. Swapping them is valid
# CloudFormation and a self-inflicted outage.
for name, template in loaded.items():
    for logical, props in resources(template, "AWS::ElasticLoadBalancingV2::TargetGroup"):
        check(
            props.get("HealthCheckPath") == "/health/ready",
            f"{name}: target group {logical} checks {props.get('HealthCheckPath')!r}. The load balancer "
            "must check readiness — liveness answers while the database is unreachable, so traffic "
            "would keep arriving at a process that cannot serve it.",
        )
        check(
            str(props.get("HealthCheckPort")) == "3011",
            f"{name}: target group {logical} probes port {props.get('HealthCheckPort')}. The probe "
            "listener is separate from the application port so an exhausted request pool cannot stop "
            "it answering.",
        )

    for logical, props in resources(template, "AWS::ECS::TaskDefinition"):
        for container in props.get("ContainerDefinitions", []):
            health = container.get("HealthCheck")
            if health is None:
                continue
            command = " ".join(str(part) for part in health.get("Command", []))
            check(
                "/health/live" in command,
                f"{name}: container {container.get('Name')} health-checks {command!r}. A container "
                "health check replaces the task, and readiness would turn a thirty-second database "
                "blip into every task restarting at once.",
            )
            if container.get("Name") == "worker":
                check("3012" in command, f"{name}: the Worker probe is on 3012, not {command!r}.")
            if container.get("Name") == "api":
                check("3011" in command, f"{name}: the API probe is on 3011, not {command!r}.")

        for container in props.get("ContainerDefinitions", []):
            if container.get("Name") == "worker":
                # It finishes the batch in flight on SIGTERM; killed early, the
                # claimed Outbox rows wait out their lease instead of being
                # handed back.
                check(
                    int(container.get("StopTimeout", 0)) >= 60,
                    f"{name}: the Worker's StopTimeout is {container.get('StopTimeout')}s, which may cut "
                    "the drain short.",
                )

# --- Secrets -----------------------------------------------------------------
for name, template in loaded.items():
    for logical, props in resources(template, "AWS::ECS::TaskDefinition"):
        for container in props.get("ContainerDefinitions", []):
            for entry in container.get("Environment", []):
                check(
                    entry.get("Name") not in SECRET_NAMES,
                    f"{name}: {logical} passes {entry.get('Name')} as an environment variable. Those are "
                    "visible in the console and in DescribeTaskDefinition — use Secrets.",
                )

# --- No long-lived credentials, anywhere -------------------------------------
KEY_PATTERNS = [
    (re.compile(r"AWS_SECRET_ACCESS_KEY"), "a stored secret access key"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "an access key id"),
    (re.compile(r"aws_access_key_id", re.I), "a credentials-file access key"),
]
scanned = list(INFRA.glob("*.yaml")) + list(WORKFLOWS.glob("*.yml"))
for path in scanned:
    text = path.read_text()
    for pattern, description in KEY_PATTERNS:
        check(
            pattern.search(text) is None,
            f"{path.name}: contains {description}. Deployment is OIDC only — a stored key has no expiry, "
            "no attribution, and no way to tell a leak from normal use.",
        )

# --- The OIDC trust boundary -------------------------------------------------
role_template = loaded.get("01-deployment-role.yaml")
if role_template is None:
    failures.append("infra/01-deployment-role.yaml is missing; there is no way in without stored keys.")
else:
    for logical, props in resources(role_template, "AWS::IAM::Role"):
        policy = props.get("AssumeRolePolicyDocument")
        if policy is None:
            continue
        for statement in policy.get("Statement", []):
            condition = statement.get("Condition", {})
            equals = condition.get("StringEquals", {})
            subject = json.dumps(equals.get("token.actions.githubusercontent.com:sub", ""))
            if "repo:" not in subject:
                continue
            check(
                "*" not in subject,
                f"01-deployment-role.yaml: {logical} trusts a wildcard subject. That trusts every "
                "workflow in the repository, including one running from a stranger's pull request.",
            )
            check(
                "StringLike" not in condition,
                f"01-deployment-role.yaml: {logical} matches the subject with StringLike; use "
                "StringEquals so the ref is exact.",
            )

# --- The deploy workflow -----------------------------------------------------
deploy = WORKFLOWS / "deploy.yml"
if not deploy.exists():
    failures.append(".github/workflows/deploy.yml is missing; nothing applies the image.")
else:
    text = deploy.read_text()
    check(
        "id-token: write" in text,
        "deploy.yml: without `id-token: write` the job cannot mint an OIDC token, and the only "
        "alternative is a stored key.",
    )
    migrate_at = text.find("run-task")
    update_at = text.find("update-service")
    check(
        migrate_at != -1 and update_at != -1 and migrate_at < update_at,
        "deploy.yml: migrations must run as a one-off task BEFORE the services roll. Running them on "
        "application start races two tasks for ADR-0020's ledger; running them after leaves new code "
        "against an old schema.",
    )

# --- Report ------------------------------------------------------------------
if failures:
    print(f"Infrastructure checks failed ({len(failures)} of {checks}):\n", file=sys.stderr)
    for failure in failures:
        print(f"  - {failure}", file=sys.stderr)
    print(
        "\nNote: passing here does not mean the templates deploy. Nothing in infra/ has been applied, "
        "and unapplied infrastructure is as unverified as an unexecuted runbook.",
        file=sys.stderr,
    )
    sys.exit(1)

print(f"Infrastructure checks passed ({checks} assertions over {len(loaded)} templates).")
print(
    "Unverified by construction: no template here has been applied. This checks that they agree with "
    "the code and the ADRs, not that AWS accepts them."
)
