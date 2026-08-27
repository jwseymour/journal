output "instance_public_ip" {
  description = "The static (Elastic) IP to point your domain's A record at."
  value       = aws_eip.journal_api.public_ip
}

output "bucket_name" {
  description = "The S3 bucket to put in S3_BUCKET in the server's .env."
  value       = aws_s3_bucket.journal.bucket
}

output "instance_id" {
  description = "For `aws ssm` / console lookups."
  value       = aws_instance.journal_api.id
}

output "iam_instance_profile" {
  description = "Confirms the instance role attached — no static AWS keys should be needed on the box."
  value       = aws_iam_instance_profile.journal_api.name
}

output "s3_assume_role_arn" {
  description = "Paste into S3_ASSUME_ROLE_ARN in apps/api's .env — the broader role apps/api assumes for journal/*/documents/* access. apps/public-api needs no such setting: it reads public/* directly via the instance role."
  value       = aws_iam_role.journal_api_write.arn
}
