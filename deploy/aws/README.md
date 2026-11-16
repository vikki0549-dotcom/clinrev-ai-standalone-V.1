# Running ClinRev on AWS

This guide maps the same container and environment variables onto managed AWS
services, so everything that handles PHI is covered by the AWS Business Associate
Addendum (BAA): ECS Fargate, RDS, ALB, Cognito, Bedrock, Secrets Manager and
CloudWatch are all HIPAA-eligible services.

```
 Route 53 (clinrev.example.com, alias record)
        │
        ▼
 ALB  ── HTTPS :443 with an ACM certificate, HTTP :80 redirects to HTTPS
  │      (optional) AWS WAF web ACL: managed rules + IP allowlist
  ▼
 ECS Fargate service "clinrev" (2+ tasks, private subnets)
  │   image: ECR clinrev-standalone:<tag>
  │   secrets from Secrets Manager → env vars
  │   task role → bedrock:InvokeModel*
  ├──► RDS PostgreSQL 16 (Multi-AZ, encrypted with KMS, private subnets)
  ├──► Amazon Bedrock (Claude models)       via VPC endpoint or NAT
  └──► Cognito user pool (OIDC)             via NAT
```

## 1. Prerequisites

- An AWS account with the **AWS BAA accepted** (AWS Artifact → Agreements).
- A domain in Route 53 (or delegate a subdomain to Route 53).
- The Bedrock Anthropic models you need enabled in the region (Bedrock console → Model access).

## 2. Network

- VPC with 2 public subnets (ALB) and 2 private subnets (ECS tasks, RDS) in two AZs.
- NAT gateway for egress from the private subnets (Cognito discovery/token calls).
  Optionally add interface VPC endpoints for `bedrock-runtime`, `secretsmanager`,
  `ecr.api`, `ecr.dkr`, `logs` and a gateway endpoint for S3 to keep that traffic private.
- Security groups:
  - `alb-sg`: inbound 443 and 80 from the internet (or only your office IPs).
  - `app-sg`: inbound 3000 from `alb-sg` only.
  - `db-sg`: inbound 5432 from `app-sg` only.

## 3. Database: RDS for PostgreSQL 16

- Engine PostgreSQL 16, Multi-AZ, storage encrypted (KMS), automated backups with
  7–35 day retention, deletion protection on, not publicly accessible, `db-sg`.
- Create database `clinrev` and a user `clinrev`. Let RDS manage the master
  password in Secrets Manager, or create a dedicated app user.
- Force TLS: parameter group `rds.force_ssl = 1`. In the app set
  `DATABASE_SSL=verify-full` and `DATABASE_CA_FILE` to the RDS CA bundle (add
  `global-bundle.pem` to the image or mount it), or `DATABASE_SSL=require`.
- Migrations run automatically when the app starts (advisory-locked, safe with several tasks).

## 4. Identity: Amazon Cognito

1. Create a user pool (email as username, MFA required or optional, advanced security on).
   Turn off self sign-up so only users you create can sign in.
2. Add a domain (Cognito domain or your own, e.g. `login.clinrev.example.com`).
3. App client: confidential client **with a client secret**, OAuth 2.0 authorization code grant,
   scopes `openid email profile`.
   - Allowed callback URL: `https://clinrev.example.com/auth/callback`
   - Allowed sign-out URL: `https://clinrev.example.com/auth/logged-out`
4. Optionally create a group `clinrev-users` and add users to it.

App settings:

| Env var | Value |
|---|---|
| `OIDC_ISSUER_URL` | `https://cognito-idp.<region>.amazonaws.com/<user-pool-id>` |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | from the app client (secret in Secrets Manager) |
| `OIDC_GROUPS_CLAIM` | `cognito:groups` |
| `OIDC_REQUIRED_GROUP` | `clinrev-users` (or use `ALLOWED_EMAIL_DOMAINS`) |
| `OIDC_END_SESSION` | `false`. Cognito does not publish `end_session_endpoint`; logout ends the app session, and the Cognito session ends at its own expiry. |

Microsoft Entra ID, Okta, Google Workspace or Auth0 work the same way; see the main README.

## 5. AI: Amazon Bedrock

- `AI_PROVIDER=bedrock`, `AWS_REGION=<region>`.
- `CLAUDE_MODEL_DEFAULT` / `CLAUDE_MODEL_QUICK`: the model IDs or cross-region inference
  profile IDs enabled in your account (Bedrock console → Model catalog), for example
  `us.anthropic.claude-sonnet-4-5-20250929-v1:0` and `us.anthropic.claude-haiku-4-5-20251001-v1:0`.
- Task role policy (no access keys in env vars):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
    "Resource": [
      "arn:aws:bedrock:*::foundation-model/anthropic.*",
      "arn:aws:bedrock:*:<account-id>:inference-profile/*"
    ]
  }]
}
```

- Turn off Bedrock model invocation logging, or send it only to an encrypted,
  access-controlled destination: prompts contain PHI.

## 6. Secrets Manager

Create one secret (JSON) such as `clinrev/prod` with:
`SESSION_SECRET`, `DATABASE_URL` (or the parts), `OIDC_CLIENT_SECRET`, and
`ANTHROPIC_API_KEY` if you use the Anthropic API instead of Bedrock.
Reference each key from the task definition's `secrets` section
(`valueFrom: arn:aws:secretsmanager:<region>:<acct>:secret:clinrev/prod:SESSION_SECRET::`).
The task **execution** role needs `secretsmanager:GetSecretValue` on that secret
(and `kms:Decrypt` if it uses a customer-managed key).

## 7. Image: ECR

```bash
aws ecr create-repository --repository-name clinrev-standalone --image-scanning-configuration scanOnPush=true --encryption-configuration encryptionType=KMS
aws ecr get-login-password | docker login --username AWS --password-stdin <acct>.dkr.ecr.<region>.amazonaws.com
docker build -t <acct>.dkr.ecr.<region>.amazonaws.com/clinrev-standalone:1.0.0 .
docker push <acct>.dkr.ecr.<region>.amazonaws.com/clinrev-standalone:1.0.0
```

## 8. ECS Fargate service

Task definition (one container):

- Image: the ECR tag above. Port 3000. `readonlyRootFilesystem: true`, plus a writable `/tmp` volume.
- CPU/memory: 0.5 vCPU / 1 GB is enough for a small practice.
- Health check: the image's `HEALTHCHECK` (`/healthz`).
- Logs: `awslogs` driver to an encrypted CloudWatch log group with a retention period.
  The app never logs prompts, record contents or tokens.
- Environment (plain): `NODE_ENV=production`, `APP_BASE_URL=https://clinrev.example.com`,
  `TRUST_PROXY=1`, `AUTH_MODE=oidc`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`,
  `OIDC_GROUPS_CLAIM`, `OIDC_REQUIRED_GROUP` or `ALLOWED_EMAIL_DOMAINS`, `ADMIN_EMAILS`,
  `OWNER_EMAILS`, `AI_PROVIDER=bedrock`, `AWS_REGION`, `CLAUDE_MODEL_DEFAULT`,
  `CLAUDE_MODEL_QUICK`, `DATABASE_SSL=verify-full`, `SESSION_IDLE_TIMEOUT_MIN=15`.
- Secrets: from step 6.

Service: desired count 2, private subnets, `app-sg`, no public IP, attached to the ALB
target group. Real-time updates work across tasks through Postgres LISTEN/NOTIFY; no
sticky sessions needed.

## 9. Load balancer, certificate, DNS

1. **ACM**: request a public certificate for `clinrev.example.com` with DNS validation
   (ACM creates the Route 53 validation record for you).
2. **Target group**: type IP, HTTP:3000, health check path `/healthz`, matcher 200,
   deregistration delay 30s.
3. **ALB** (internet-facing, public subnets, `alb-sg`):
   - Listener 443 HTTPS with the ACM certificate and policy `ELBSecurityPolicy-TLS13-1-2-2021-06`, forward to the target group.
   - Listener 80: redirect to HTTPS 443.
   - **Idle timeout: 120 seconds** or more (Server-Sent Events send a keep-alive every 25 seconds).
   - Optional: AWS WAF with AWS managed rule groups and an IP set allowlist.
4. **Route 53**: an A (alias) record `clinrev.example.com` → the ALB.

## 10. Verify

```bash
curl -sI https://clinrev.example.com/healthz     # 200
curl -sI https://clinrev.example.com/            # 302 to /auth/login
```

Sign in through Cognito, then check the CloudWatch logs for `"msg":"listening"` and no errors.

## 11. Backups and audit

- RDS automated backups + snapshots (encrypted). Test a restore into a scratch instance.
- The `audit_log` table is append-only (a trigger blocks UPDATE/DELETE/TRUNCATE). For
  long-term retention, export it periodically (e.g. a scheduled ECS task running
  `psql -c "\copy (select * from audit_log where at < now() - interval '90 days') to stdout csv"`
  to an S3 bucket with Object Lock), then prune it as a superuser.
- Turn on CloudTrail for the account (API audit), and AWS Config / Security Hub as you see fit.

## Optional: infrastructure as code

The steps above map one-to-one to CloudFormation / CDK / Terraform resources
(`AWS::ECS::TaskDefinition`, `AWS::ECS::Service`, `AWS::RDS::DBInstance`,
`AWS::ElasticLoadBalancingV2::*`, `AWS::CertificateManager::Certificate`,
`AWS::Route53::RecordSet`, `AWS::Cognito::UserPool*`, `AWS::SecretsManager::Secret`).
Keep the environment variable names exactly as in `.env.example`.
