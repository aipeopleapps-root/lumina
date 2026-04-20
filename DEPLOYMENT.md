# Deployment Guide - From Local to Production

This guide takes you from "works on my laptop" to "live in production with CI/CD."

---

## 🎯 Current State → Target State

**Current (What you have now):**
- ✅ Runs on localhost:5173
- ✅ Deployed to AWS manually via `npx cdk deploy`
- ✅ Environment variables in `.env.local` files
- ❌ Not accessible publicly
- ❌ No version control
- ❌ Manual deployment process

**Target (What we're building):**
- ✅ Accessible at https://workday-ai.your-domain.com
- ✅ Code in GitHub with proper branching
- ✅ Auto-deploys on merge to main
- ✅ Secrets managed securely
- ✅ Multiple environments (dev, prod)

---

## Phase 1: Version Control (GitHub)

### Step 1.1: Initialize Git Repository

```bash
cd /Users/aashish/Downloads/workday-ai-platform

# Initialize Git
git init

# Add all files (gitignore will exclude sensitive stuff)
git add .

# First commit
git commit -m "Initial commit: Multi-tenant Workday AI platform

- AWS CDK infrastructure (VPC, Aurora, DynamoDB, Lambda, API Gateway, Cognito)
- React frontend with consultant and client personas
- RAG-based chat using Claude Sonnet 4 + Titan Embeddings
- DynamoDB vector search with cosine similarity
- Complete tenant isolation at all layers"
```

### Step 1.2: Create GitHub Repository

1. Go to https://github.com/new
2. Repository name: `workday-ai-platform`
3. **Private** repository (contains AWS config)
4. **Do NOT** initialize with README (we have one)
5. Click "Create repository"

### Step 1.3: Push to GitHub

```bash
# Add remote (replace YOUR-USERNAME with your GitHub username)
git remote add origin https://github.com/YOUR-USERNAME/workday-ai-platform.git

# Push
git branch -M main
git push -u origin main
```

**✅ Checkpoint:** Your code is now backed up on GitHub!

---

## Phase 2: Make Frontend Publicly Accessible

### Option A: AWS Amplify Hosting (Easiest)

**Pros:** Auto-deployment, HTTPS, CDN, custom domains  
**Cons:** Costs ~$1/month for small sites

```bash
cd frontend

# Install Amplify CLI
npm install -g @aws-amplify/cli

# Configure Amplify
amplify init
# ? Enter a name: workday-ai-frontend
# ? Choose your default editor: Visual Studio Code
# ? Choose the type of app: javascript
# ? Framework: react
# ? Source directory: src
# ? Distribution directory: dist
# ? Build command: npm run build
# ? Start command: npm run dev

# Add hosting
amplify add hosting
# ? Select the plugin module: Hosting with Amplify Console
# ? Choose a type: Manual deployment

# Deploy
amplify publish
```

**Output:** You'll get a URL like `https://main.d3abcd1234.amplifyapp.com`

### Option B: S3 + CloudFront (More control)

Update `infra/lib/stack.ts` to add:

```typescript
// Frontend hosting bucket
const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
  websiteIndexDocument: 'index.html',
  publicReadAccess: true,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

// CloudFront distribution
const distribution = new cloudfront.Distribution(this, 'Distribution', {
  defaultBehavior: {
    origin: new origins.S3Origin(frontendBucket),
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
  },
  defaultRootObject: 'index.html',
});

new cdk.CfnOutput(this, 'FrontendUrl', {
  value: `https://${distribution.distributionDomainName}`,
});
```

### Step 2.1: Update CORS for Public Access

In `infra/lib/stack.ts`, update the S3 CORS and API Gateway CORS:

```typescript
const docsBucket = new s3.Bucket(this, 'DocsBucket', {
  // ... existing config ...
  cors: [
    {
      allowedMethods: [
        s3.HttpMethods.GET,
        s3.HttpMethods.PUT,
        s3.HttpMethods.POST,
      ],
      allowedOrigins: [
        'http://localhost:5173',
        'https://main.d3abcd1234.amplifyapp.com', // Add your Amplify URL
        'https://workday-ai.your-domain.com',      // Add your custom domain
      ],
      allowedHeaders: ['*'],
      exposedHeaders: ['ETag'],
    },
  ],
});

const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
  corsPreflight: {
    allowOrigins: [
      'http://localhost:5173',
      'https://main.d3abcd1234.amplifyapp.com',
      'https://workday-ai.your-domain.com',
    ],
    allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
    allowHeaders: ['Content-Type', 'Authorization'],
  },
});
```

### Step 2.2: Update Cognito Redirect URLs

```typescript
const userPoolClient = userPool.addClient('WebClient', {
  authFlows: { userSrp: true, userPassword: true },
  generateSecret: false,
  accessTokenValidity: cdk.Duration.hours(8),
  idTokenValidity: cdk.Duration.hours(8),
  oAuth: {
    callbackUrls: [
      'http://localhost:5173',
      'https://main.d3abcd1234.amplifyapp.com',
      'https://workday-ai.your-domain.com',
    ],
    logoutUrls: [
      'http://localhost:5173',
      'https://main.d3abcd1234.amplifyapp.com',
      'https://workday-ai.your-domain.com',
    ],
  },
});
```

**Deploy changes:**
```bash
cd infra
npx cdk deploy
```

---

## Phase 3: GitHub Actions CI/CD

### Step 3.1: AWS Credentials for GitHub

**Create IAM User for CI/CD:**

```bash
aws iam create-user --user-name github-actions-deployer

# Attach admin policy (for CDK deployments)
aws iam attach-user-policy \
  --user-name github-actions-deployer \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess

# Create access keys
aws iam create-access-key --user-name github-actions-deployer
```

**Save the output:**
- `AccessKeyId`: AKIA...
- `SecretAccessKey`: xxxxx...

### Step 3.2: Add Secrets to GitHub

1. Go to your GitHub repo → Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Add these secrets:
   - `AWS_ACCESS_KEY_ID` = (from above)
   - `AWS_SECRET_ACCESS_KEY` = (from above)
   - `AWS_REGION` = `us-east-1`

### Step 3.3: Create GitHub Actions Workflow

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to AWS

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  deploy-infrastructure:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Setup Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.12'
      
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ secrets.AWS_REGION }}
      
      - name: Install CDK dependencies
        run: |
          cd infra
          npm install
      
      - name: Install Lambda dependencies
        run: |
          cd lambdas
          for dir in upload_url ingest analyze chat; do
            pip install -r $dir/requirements.txt -t $dir/ --break-system-packages || true
          done
      
      - name: CDK Deploy
        if: github.ref == 'refs/heads/main'
        run: |
          cd infra
          npx cdk deploy --require-approval never
      
      - name: CDK Diff (PR only)
        if: github.event_name == 'pull_request'
        run: |
          cd infra
          npx cdk diff

  deploy-frontend:
    needs: deploy-infrastructure
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: |
          cd frontend
          npm install
      
      - name: Build
        run: |
          cd frontend
          npm run build
        env:
          VITE_API_ENDPOINT: ${{ secrets.VITE_API_ENDPOINT }}
          VITE_USER_POOL_ID: ${{ secrets.VITE_USER_POOL_ID }}
          VITE_USER_POOL_CLIENT_ID: ${{ secrets.VITE_USER_POOL_CLIENT_ID }}
          VITE_AWS_REGION: ${{ secrets.AWS_REGION }}
      
      - name: Deploy to Amplify
        run: |
          # Add Amplify deployment commands here
          echo "Deploy to hosting"
```

### Step 3.4: Add Frontend Secrets

Add these to GitHub Secrets:
- `VITE_API_ENDPOINT` = Your API Gateway URL
- `VITE_USER_POOL_ID` = Your Cognito User Pool ID
- `VITE_USER_POOL_CLIENT_ID` = Your Cognito Client ID

---

## Phase 4: Multiple Environments

### Step 4.1: Environment-Specific Stacks

Update `infra/bin/app.ts`:

```typescript
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { WorkdayAiPlatformStack } from '../lib/stack';

const app = new cdk.App();

// Get environment from context or default to 'dev'
const environment = app.node.tryGetContext('environment') || 'dev';

new WorkdayAiPlatformStack(app, `WorkdayAiPlatformStack-${environment}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  stackName: `workday-ai-platform-${environment}`,
});
```

### Step 4.2: Deploy Different Environments

```bash
# Dev environment
npx cdk deploy --context environment=dev

# Production environment
npx cdk deploy --context environment=prod
```

### Step 4.3: Separate GitHub Workflows

Create `.github/workflows/deploy-dev.yml` (triggers on push to `develop` branch)  
Create `.github/workflows/deploy-prod.yml` (triggers on push to `main` branch)

---

## Phase 5: Custom Domain (Optional)

### Step 5.1: Get a Domain

**Option A:** AWS Route 53
```bash
aws route53domains register-domain --domain-name workday-ai-platform.com
```

**Option B:** External (Namecheap, GoDaddy, etc.)

### Step 5.2: Create SSL Certificate

```bash
aws acm request-certificate \
  --domain-name workday-ai-platform.com \
  --subject-alternative-names '*.workday-ai-platform.com' \
  --validation-method DNS \
  --region us-east-1
```

### Step 5.3: Update Stack for Custom Domain

Add to `infra/lib/stack.ts`:

```typescript
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

// Reference existing certificate
const certificate = acm.Certificate.fromCertificateArn(
  this,
  'Certificate',
  'arn:aws:acm:us-east-1:ACCOUNT:certificate/CERT-ID'
);

// CloudFront with custom domain
const distribution = new cloudfront.Distribution(this, 'Distribution', {
  defaultBehavior: {
    origin: new origins.S3Origin(frontendBucket),
  },
  domainNames: ['workday-ai-platform.com', 'www.workday-ai-platform.com'],
  certificate,
});

// Route53 records
const hostedZone = route53.HostedZone.fromLookup(this, 'Zone', {
  domainName: 'workday-ai-platform.com',
});

new route53.ARecord(this, 'AliasRecord', {
  zone: hostedZone,
  target: route53.RecordTarget.fromAlias(
    new targets.CloudFrontTarget(distribution)
  ),
});
```

---

## 🔒 Security Checklist for Production

- [ ] Remove default passwords (`TempPass123!`) - force users to set their own
- [ ] Enable MFA for Cognito
- [ ] Enable CloudWatch alarms for errors
- [ ] Set up budget alerts in AWS
- [ ] Enable DynamoDB point-in-time recovery
- [ ] Enable Aurora automated backups
- [ ] Rotate AWS access keys regularly
- [ ] Use AWS Secrets Manager for sensitive config
- [ ] Enable CloudTrail for audit logging
- [ ] Set up WAF rules on API Gateway
- [ ] Review IAM policies (principle of least privilege)

---

## 💰 Cost Optimization for Production

### Remove NAT Gateway (Biggest Cost - $32/month)

**Option 1:** Use VPC Endpoints (free)
```typescript
vpc.addInterfaceEndpoint('BedrockEndpoint', {
  service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
});
```

**Option 2:** Move Lambdas out of VPC (if Aurora isn't needed)

### Enable Auto-Scaling

```typescript
const vectorTable = new dynamodb.Table(this, 'VectorTable', {
  // Change from PAY_PER_REQUEST to PROVISIONED with auto-scaling
  billingMode: dynamodb.BillingMode.PROVISIONED,
  readCapacity: 5,
  writeCapacity: 5,
});

// Add auto-scaling
const readScaling = vectorTable.autoScaleReadCapacity({
  minCapacity: 1,
  maxCapacity: 50,
});
readScaling.scaleOnUtilization({ targetUtilizationPercent: 70 });
```

---

## 📊 Monitoring & Alerts

### CloudWatch Dashboard

Create custom dashboard:
```typescript
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
  dashboardName: 'workday-ai-platform',
});

dashboard.addWidgets(
  new cloudwatch.GraphWidget({
    title: 'Lambda Invocations',
    left: [chatFn.metricInvocations()],
  }),
  new cloudwatch.GraphWidget({
    title: 'Lambda Errors',
    left: [chatFn.metricErrors()],
  })
);
```

### Alarms

```typescript
chatFn.metricErrors().createAlarm(this, 'ChatFnErrorsAlarm', {
  threshold: 10,
  evaluationPeriods: 1,
  alarmDescription: 'Chat function error rate too high',
});
```

---

## 🚀 Deployment Workflow

**Development:**
1. Create feature branch: `git checkout -b feature/new-feature`
2. Make changes locally
3. Test: `npm run dev` (frontend), `npx cdk diff` (infra)
4. Commit: `git commit -m "Add new feature"`
5. Push: `git push origin feature/new-feature`
6. Create PR on GitHub
7. GitHub Actions runs tests + CDK diff
8. Review + Merge to main
9. GitHub Actions auto-deploys to production

**Hotfix:**
1. Create hotfix branch from main
2. Fix + test
3. Merge directly to main (skip PR for emergencies)
4. Auto-deploys immediately

---

## 🐛 Troubleshooting CI/CD

**GitHub Actions fails with "Access Denied":**
- Check IAM user has correct permissions
- Verify secrets in GitHub are correct

**CDK deploy times out:**
- Increase GitHub Actions timeout: `timeout-minutes: 30`
- Check VPC/NAT Gateway aren't blocking outbound

**Frontend build fails:**
- Check all environment variables are set in GitHub Secrets
- Verify Node version matches local (18.x)

---

## 📚 Next Steps

1. ✅ Set up GitHub repository
2. ✅ Deploy frontend to Amplify or S3+CloudFront
3. ✅ Configure GitHub Actions
4. ⬜ Add automated tests (Jest, Pytest)
5. ⬜ Set up monitoring dashboards
6. ⬜ Configure custom domain
7. ⬜ Implement blue-green deployments
8. ⬜ Add performance monitoring (X-Ray)

**Ready to start?** Follow Phase 1 first!
