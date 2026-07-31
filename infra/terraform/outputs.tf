output "environment_identity" { value = "${var.environment}:${var.aws_region}" }
output "vpc_id" { value = aws_vpc.main.id }
output "private_subnet_ids" { value = aws_subnet.private[*].id }
output "api_repository_url" { value = aws_ecr_repository.api.repository_url }
output "worker_repository_url" { value = aws_ecr_repository.worker.repository_url }
output "ecs_cluster_arn" { value = aws_ecs_cluster.main.arn }
output "database_endpoint" { value = aws_db_instance.main.endpoint }
output "database_secret_arn" { value = aws_secretsmanager_secret.database.arn }
output "operations_topic_arn" { value = aws_sns_topic.operations.arn }

