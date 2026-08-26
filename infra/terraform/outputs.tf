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
