# Variables for the journal's M11 infrastructure (`docs/plan.md` M11,
# `docs/deployment.md`). Deliberately flat and single-environment — this is
# a solo, low-ops personal deployment, not something that needs modules,
# workspaces, or remote state for more than one environment.

variable "aws_region" {
  description = "AWS region for every resource here. The bucket and the instance must be in the same region."
  type        = string
  default     = "eu-west-2"
}

variable "bucket_name" {
  description = <<-EOT
    Name of the S3 bucket that becomes the canonical journal store.
    Bucket names are globally unique across ALL of AWS, not just your
    account — pick something specific to you, e.g. "jack-journal-<random suffix>".
    No default on purpose: you must choose this yourself.
  EOT
  type        = string
}

variable "ssh_allowed_cidr" {
  description = <<-EOT
    CIDR block allowed to reach the instance on port 22. Set this to your
    own IP as a /32, e.g. "203.0.113.4/32" — find it with `curl -4 ifconfig.me`.
    No default on purpose: leaving SSH open to the world is not an acceptable
    default for a box holding an IAM role scoped to your journal bucket.
  EOT
  type        = string
}

variable "key_pair_name" {
  description = <<-EOT
    Name of an EC2 key pair that already exists in this region. Terraform
    does not create it — a keypair Terraform generates has to have its
    private half stored *somewhere*, which is exactly the kind of extra
    secret this deployment is trying to avoid. Create one yourself first:
      aws ec2 create-key-pair --key-name journal-key \
        --query 'KeyMaterial' --output text > ~/.ssh/journal-key.pem
      chmod 400 ~/.ssh/journal-key.pem
  EOT
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type. t4g.micro (ARM/Graviton) is the cheapest general-purpose size and is comfortably enough for a single-user API plus local Whisper/embedding models."
  type        = string
  default     = "t4g.micro"
}

variable "root_volume_size_gb" {
  description = "Root EBS volume size in GB. Sized generously for the SQLite index plus cached model weights (a few hundred MB each), not for the journal itself (that lives in S3, not on this disk)."
  type        = number
  default     = 30
}

variable "project_name" {
  description = "Short name used to tag and name every resource here."
  type        = string
  default     = "journal"
}
