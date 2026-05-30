# Lantern Trade Chat — AWS Deploy

Metadata: app `apps/lantern-trade-chat`; provider AWS App Runner (compatible AWS
container service); region `us-east-1`; container port `8080`.

## Simple Answer

The Lantern Trade Chat app runs on **AWS** (App Runner), not Fly.io. App Runner is
a compatible AWS container service that gives an HTTPS URL automatically, which the
GitHub OAuth callback requires. The image is built locally, pushed to ECR, and run
as an App Runner service.

Live URL: https://p2rsjfppsr.us-east-1.awsapprunner.com (demo mode, login-walled).

## What It Actually Does

- Builds `apps/lantern-trade-chat/Dockerfile` for `linux/amd64`.
- Pushes to ECR repo `lantern-trade-chat`.
- Runs an App Runner service on port 8080 with the same safety defaults as the
  container: `KALSHI_ENVIRONMENT=demo`, `LANTERN_LIVE_ENABLED=0`.

## Evidence / Source Discipline

Verified on deploy (release gate for this app is `/` and `/api/health`; the
`/api/cloud-mirrors` route belongs to the lantern-garage dashboard, not this app):

```
GET /api/health -> 200 {"status":"ok","environment":"demo","liveEnabled":false,...}
GET /            -> 200 (<title>Lantern Trade Chat</title>)
```

## Proven / Held / Local-Only

- Proven: image builds, pushes to ECR, App Runner reaches `RUNNING`, both gate
  endpoints return 200.
- Held: real-money trading stays off until OAuth + prod Kalshi creds are wired and
  the operator explicitly arms it (`LANTERN_LIVE_ENABLED=1`), with kill switch and
  per-order / per-day / 1-trade-per-day caps still enforced.

## Next Safe Action

1. Operator creates a GitHub OAuth App with callback
   `https://p2rsjfppsr.us-east-1.awsapprunner.com/auth/callback`.
2. Wire `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`,
   `GITHUB_ALLOWED_LOGINS` as App Runner runtime env vars and redeploy.

## Validation Path

After any deploy, confirm both gate endpoints:

```bash
URL=https://p2rsjfppsr.us-east-1.awsapprunner.com
curl -s -o /dev/null -w '%{http_code}\n' "$URL/"
curl -s "$URL/api/health"
```

## Appendix — Verified Commands

Prereqs: AWS CLI v2, Docker, AWS creds for IAM user `devin-lantern-deploy`
(account `528081867536`).

```bash
ACCOUNT=528081867536; REGION=us-east-1; REPO=lantern-trade-chat
REG="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

# 1. ECR repo
aws ecr create-repository --repository-name "$REPO" \
  --image-scanning-configuration scanOnPush=true

# 2. Build + push
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REG"
docker build --platform linux/amd64 -t "$REPO:latest" \
  -f apps/lantern-trade-chat/Dockerfile apps/lantern-trade-chat
docker tag "$REPO:latest" "$REG/$REPO:latest"
docker push "$REG/$REPO:latest"

# 3. App Runner ECR access role (once)
aws iam create-role --role-name AppRunnerECRAccessRole \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"build.apprunner.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name AppRunnerECRAccessRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess

# 4. Create service (see manifests/cloud-mirrors.json for the live ARN/URL).
#    Redeploy after a new image push:
aws apprunner start-deployment --service-arn <service-arn>
```

Note: in this environment the injected `AWS_SECRET_ACCESS_KEY` env var was
unreliable; writing a clean `~/.aws/credentials` and running the CLI with the env
vars unset (`env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY aws ...`) was the
reliable path.
