data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "aios-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = local.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name}-public-${count.index + 1}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  tags               = { Name = "${local.name}-private-${count.index + 1}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "api" {
  name        = "${local.name}-api"
  description = "API tasks; inbound is added with the load balancer service."
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "worker" {
  name        = "${local.name}-worker"
  description = "Background workers have no inbound path."
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "PostgreSQL accepts traffic only from AIOS runtime roles."
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id, aws_security_group.worker.id]
  }
}

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "random_password" "database" {
  length  = 40
  special = true
}

resource "aws_secretsmanager_secret" "database" {
  name                    = "${local.name}/database/master"
  recovery_window_in_days = var.environment == "production" ? 30 : 7
}

resource "aws_secretsmanager_secret_version" "database" {
  secret_id = aws_secretsmanager_secret.database.id
  secret_string = jsonencode({
    username = "aios_admin"
    password = random_password.database.result
    database = var.database_name
  })
}

resource "aws_db_instance" "main" {
  identifier                     = local.name
  engine                         = "postgres"
  engine_version                 = "17"
  instance_class                 = var.database_instance_class
  allocated_storage              = 20
  max_allocated_storage          = 100
  storage_type                   = "gp3"
  storage_encrypted              = true
  db_name                        = var.database_name
  username                       = "aios_admin"
  password                       = random_password.database.result
  db_subnet_group_name           = aws_db_subnet_group.main.name
  vpc_security_group_ids         = [aws_security_group.database.id]
  publicly_accessible            = false
  backup_retention_period        = var.database_backup_retention_days
  backup_window                  = "17:00-18:00"
  maintenance_window             = "sun:18:00-sun:19:00"
  auto_minor_version_upgrade     = true
  deletion_protection            = var.deletion_protection
  skip_final_snapshot            = var.environment != "production"
  final_snapshot_identifier      = var.environment == "production" ? "${local.name}-final" : null
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  performance_insights_enabled   = true
  apply_immediately              = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_ecr_repository" "api" {
  name                 = "${local.name}/api"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecr_repository" "worker" {
  name                 = "${local.name}/worker"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aios/${var.environment}/api"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aios/${var.environment}/worker"
  retention_in_days = 30
}

resource "aws_sns_topic" "operations" {
  name = "${local.name}-operations"
}

resource "aws_sns_topic_subscription" "operator_email" {
  topic_arn = aws_sns_topic.operations.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "database_cpu" {
  alarm_name          = "${local.name}-database-high-cpu"
  alarm_description   = "RDS CPU is above 80 percent for 15 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.id }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
}

