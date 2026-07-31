# AIOS AWS environment foundation

This directory defines the first production-equivalent AWS boundary. It does not deploy an application service yet. It creates the isolated network, private PostgreSQL 17 database, immutable ECR repositories, ECS cluster, bounded log retention, Secrets Manager entry, SNS destination, and an initial RDS alarm.

## Safety boundary

- Use a named MFA-protected Human role; never use root credentials or root access keys.
- Start with `staging`. Production requires a separate review, state, VPC CIDR, and approval.
- `terraform apply` creates billable AWS resources. Review the saved plan before applying it.
- The database has `prevent_destroy` and deletion protection. Do not weaken either to work around a failed change.
- Terraform state contains sensitive generated values. Local state is ignored, but the shared backend must be encrypted and access controlled before team use.
- The generated master credential is for database administration and migrations. ECS application tasks must receive a separate least-privilege runtime credential before application deployment.
- Private subnets intentionally have no default internet route yet. ECS services and VPC endpoints/NAT are selected together in the next increment to avoid accidental NAT Gateway cost.

## First staging plan

```sh
cp staging.tfvars.example staging.tfvars
# Replace alert_email with the named Human operator destination.
terraform init
terraform fmt -check -recursive
terraform validate
terraform plan -var-file=staging.tfvars -out=staging.tfplan
terraform show staging.tfplan
```

Stop after reviewing the plan. Applying the plan requires explicit approval because it creates chargeable infrastructure and sends an SNS confirmation email. After apply, the operator must confirm the SNS subscription before alert delivery can be proven.

## State bootstrap

The initial plan uses local state so the account and resource names can be verified without assuming an existing backend. Before the first shared or production apply, create a dedicated encrypted S3 state bucket with versioning and a DynamoDB-compatible locking strategy, then add a reviewed backend configuration. The state bootstrap must live outside the state it protects.

## Next increment

The next increment adds ALB, ECS task definitions/services, least-privilege task roles, GitHub OIDC deployment roles, VPC endpoints or a reviewed NAT design, migration tasks, application alarms, and deployment evidence. No public database path will be introduced.

