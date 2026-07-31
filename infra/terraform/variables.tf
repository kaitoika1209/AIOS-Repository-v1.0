variable "aws_region" {
  description = "AWS Region for the complete environment."
  type        = string
  default     = "ap-northeast-1"
}

variable "environment" {
  description = "Environment identity used in names and evidence."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "vpc_cidr" {
  description = "Environment-specific VPC CIDR."
  type        = string
  default     = "10.20.0.0/16"
}

variable "database_name" {
  type    = string
  default = "aios"
}

variable "database_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "database_backup_retention_days" {
  type    = number
  default = 7

  validation {
    condition     = var.database_backup_retention_days >= 7 && var.database_backup_retention_days <= 35
    error_message = "backup retention must be between 7 and 35 days."
  }
}

variable "alert_email" {
  description = "Named Human operator email. SNS requires confirmation before alerts are delivered."
  type        = string
  sensitive   = true
}

variable "deletion_protection" {
  description = "Must remain enabled for production."
  type        = bool
  default     = true

  validation {
    condition     = var.environment != "production" || var.deletion_protection
    error_message = "production requires deletion protection."
  }
}

