# ── S3 bucket: the canonical journal store (`requirements.md` §7.3) ────────

resource "aws_s3_bucket" "journal" {
  bucket = var.bucket_name

  tags = {
    Project = var.project_name
  }
}

resource "aws_s3_bucket_versioning" "journal" {
  bucket = aws_s3_bucket.journal.id
  versioning_configuration {
    status = "Enabled" # The safety net (`requirements.md` §7.4) — replaces git's role.
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "journal" {
  bucket = aws_s3_bucket.journal.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256" # Default SSE-S3 — costs nothing, satisfies §7.3's encryption note.
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "journal" {
  bucket                  = aws_s3_bucket.journal.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ── IAM: an instance role, not a static access key ──────────────────────────
#
# EC2 (rather than Lightsail) was chosen specifically so the server can
# authenticate to S3 via its instance role — the AWS SDK's default credential
# provider chain picks this up automatically from instance metadata, with no
# key anywhere in `.env`. Scoped to exactly this bucket's `journal/` prefix,
# nothing else.

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "journal_api" {
  name               = "${var.project_name}-api"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

data "aws_iam_policy_document" "journal_bucket_access" {
  statement {
    sid       = "ListJournalPrefix"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.journal.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["journal/*"]
    }
  }

  statement {
    sid       = "ReadWriteJournalObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.journal.arn}/journal/*"]
  }
}

resource "aws_iam_role_policy" "journal_api" {
  name   = "${var.project_name}-api-s3-access"
  role   = aws_iam_role.journal_api.id
  policy = data.aws_iam_policy_document.journal_bucket_access.json
}

resource "aws_iam_instance_profile" "journal_api" {
  name = "${var.project_name}-api"
  role = aws_iam_role.journal_api.name
}

# ── Networking ───────────────────────────────────────────────────────────

resource "aws_security_group" "journal_api" {
  name        = "${var.project_name}-api"
  description = "Journal API host: HTTP/HTTPS from anywhere, SSH from one IP only."

  ingress {
    description = "HTTP (Lets Encrypt challenge, redirected to HTTPS by Caddy)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "SSH, restricted to your own IP"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ssh_allowed_cidr]
  }

  egress {
    description = "All outbound (S3, package installs, Lets Encrypt, etc.)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Project = var.project_name
  }
}

# ── The instance ─────────────────────────────────────────────────────────

data "aws_ami" "ubuntu_arm64" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_instance" "journal_api" {
  ami                    = data.aws_ami.ubuntu_arm64.id
  instance_type          = var.instance_type
  key_name               = var.key_pair_name
  iam_instance_profile   = aws_iam_instance_profile.journal_api.name
  vpc_security_group_ids = [aws_security_group.journal_api.id]

  # Runs once, on first boot, as root — see `infra/bootstrap.sh`. Installs
  # Node, Caddy, and prepares the service user; does not start anything that
  # depends on secrets that don't exist yet (those are filled in over SSH,
  # per `docs/deployment.md`).
  user_data = file("${path.module}/../bootstrap.sh")

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_size_gb
    encrypted   = true
  }

  tags = {
    Name    = "${var.project_name}-api"
    Project = var.project_name
  }
}

resource "aws_eip" "journal_api" {
  instance = aws_instance.journal_api.id
  domain   = "vpc"

  tags = {
    Project = var.project_name
  }
}
