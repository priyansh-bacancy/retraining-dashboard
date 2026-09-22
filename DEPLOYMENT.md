# DevOps build and AWS deployment

This application must run as a persistent Node.js service. Do not deploy it as
a static export: the Next.js API routes access S3 and extract video frames with
the bundled FFmpeg binaries.

## 1. Runtime requirements

- Linux host, container, or EC2 instance with Node.js `22.13+` and npm
- Network access to AWS S3 and STS
- An instance/task role with the S3 permissions below
- Port `3000` available behind the load balancer or reverse proxy

## 2. AWS configuration

Use an EC2 instance role or ECS task role in production. Do not store AWS access
keys in the repository or environment file.

Minimum IAM policy (replace the bucket name if required):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListRetrainingBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::icu-solarcam-storage-bacancy-ap-southeast-2"
    },
    {
      "Sid": "ReadRetrainingObjects",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::icu-solarcam-storage-bacancy-ap-southeast-2/*"
    },
    {
      "Sid": "WriteManualCorrections",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::icu-solarcam-storage-bacancy-ap-southeast-2/manual-annotations/*"
    },
    {
      "Sid": "VerifyRuntimeIdentity",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    }
  ]
}
```

If the bucket uses a customer-managed KMS key, also grant `kms:Decrypt`,
`kms:Encrypt`, and `kms:GenerateDataKey` for that key.

Create the production environment file:

```bash
sudo tee /etc/icu-retraining-dashboard.env >/dev/null <<'EOF'
NODE_ENV=production
PORT=3000
AWS_REGION=ap-southeast-2
RETRAINING_BUCKET=icu-solarcam-storage-bacancy-ap-southeast-2
RETRAINING_SAMPLE_INTERVAL=15
EOF
sudo chmod 600 /etc/icu-retraining-dashboard.env
```

Verify the attached AWS role and bucket access:

```bash
aws sts get-caller-identity
aws s3api head-bucket --bucket icu-solarcam-storage-bacancy-ap-southeast-2
aws s3api list-objects-v2 --bucket icu-solarcam-storage-bacancy-ap-southeast-2 --max-items 5
```

S3 CORS configuration is not required because S3 is accessed only by the
server. Restrict inbound port `3000` to the load balancer or reverse proxy.

## 3. Install, validate, and build

Run from the repository root:

```bash
node --version
npm --version
npm ci
npm run lint
node --test tests/*.test.mjs server/*.test.mjs
npm run build
```

## 4. Run with systemd

Create a dedicated service account and give it ownership of the checked-out
application directory. Replace `/opt/retraining-dashboard` if the deployment
path is different.

```bash
sudo useradd --system --home /opt/retraining-dashboard --shell /usr/sbin/nologin icu-dashboard || true
sudo chown -R icu-dashboard:icu-dashboard /opt/retraining-dashboard
```

Create `/etc/systemd/system/icu-retraining-dashboard.service`:

```ini
[Unit]
Description=ICU Retraining Dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=icu-dashboard
Group=icu-dashboard
WorkingDirectory=/opt/retraining-dashboard
EnvironmentFile=/etc/icu-retraining-dashboard.env
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now icu-retraining-dashboard
sudo systemctl status icu-retraining-dashboard --no-pager
```

## 5. Deploy a release

```bash
cd /opt/retraining-dashboard
git fetch origin --prune
git checkout <release-branch-or-tag>
git pull --ff-only origin <release-branch>
npm ci
npm run lint
node --test tests/*.test.mjs server/*.test.mjs
npm run build
sudo systemctl restart icu-retraining-dashboard
curl --fail http://127.0.0.1:3000/api/health
```

For a tag or exact commit, omit `git pull` and use
`git checkout --detach <tag-or-commit>`.

## 6. Logs and rollback

```bash
sudo journalctl -u icu-retraining-dashboard -n 200 --no-pager
sudo journalctl -u icu-retraining-dashboard -f
```

Rollback to a known good tag or commit:

```bash
cd /opt/retraining-dashboard
git fetch origin --tags
git checkout --detach <known-good-tag-or-commit>
npm ci
npm run build
sudo systemctl restart icu-retraining-dashboard
curl --fail http://127.0.0.1:3000/api/health
```

The deployment is healthy when `/api/health` returns HTTP `200` and reports the
expected AWS account, region, and S3 bucket.
