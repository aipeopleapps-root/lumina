# Workday AI Platform - Complete Project Guide

## 🎯 What This Platform Does

This is a **multi-tenant AI-powered Workday consulting platform** with two personas:

1. **Consultant Portal** - Upload Workday configuration workbooks, get AI-generated risk analysis and best practice recommendations
2. **Client Coach** - Ask questions about Workday, get grounded answers with citations from uploaded configs and knowledge base

**Key Feature:** Complete tenant isolation - Acme Corp can't see Globex's data, enforced at every layer.

---

## 📁 Project Structure Explained

```
workday-ai-platform/
├── docs/                    # Architecture diagrams (SVG files you created)
├── frontend/                # React web application
│   ├── src/
│   │   ├── components/      # UI components (ConsultantPanel, CoachPanel)
│   │   ├── lib/            # API client, auth utilities
│   │   └── App.tsx         # Main app with routing
│   ├── .env.local          # Frontend config (API endpoint, Cognito IDs)
│   └── package.json        # Node dependencies
├── infra/                   # AWS CDK infrastructure code
│   ├── lib/
│   │   └── stack.ts        # THE BLUEPRINT - defines all AWS resources
│   ├── bin/
│   │   └── app.ts          # Entry point for CDK
│   └── package.json        # CDK dependencies
├── lambdas/                 # Backend Python functions
│   ├── common/             # Shared utilities used by all Lambdas
│   │   ├── tenant.py       # Tenant isolation enforcement
│   │   ├── bedrock.py      # AI model calls (Claude + Titan)
│   │   ├── dynamo_vectors.py  # Vector search logic
│   │   ├── chunking.py     # Document parsing (XLSX, PDF, DOCX)
│   │   ├── audit.py        # Logging to Aurora
│   │   └── http.py         # HTTP response helpers
│   ├── upload_url/         # Generates presigned S3 URLs
│   ├── ingest/             # Parses, chunks, embeds, indexes documents
│   ├── analyze/            # AI analysis of workbooks
│   └── chat/               # RAG-based Q&A
├── seed-data/              # Scripts to populate demo data
│   ├── seed.py            # Creates users, schemas, KB passages
│   └── workbook_gen.py    # Generates synthetic Workday workbooks
└── README.md              # Setup instructions
```

---

## 🏗️ Architecture Overview

### The Request Flow (How It All Connects)

**When a client asks a question in the chat:**

```
1. Browser (React)
   ↓ POST /chat + JWT token
   
2. API Gateway
   ↓ Validates JWT (tenant_id + role extracted)
   
3. Chat Lambda (Python)
   ├─→ Extracts tenant_id from JWT
   ├─→ Bedrock: Embeds the question → 1024-dim vector
   ├─→ DynamoDB: Query chunks WHERE tenant_id = 'acme'
   ├─→ In-Lambda: Cosine similarity ranking → top 6 chunks
   ├─→ Bedrock: Claude generates answer with context
   └─→ Returns: {answer, citations}
   
4. Browser displays answer + citation pills
```

**When a consultant uploads a workbook:**

```
1. Browser requests presigned URL
   ↓ POST /upload-url + filename
   
2. Upload URL Lambda
   └─→ Returns presigned S3 PUT URL (expires in 5 min)
   
3. Browser uploads file DIRECTLY to S3
   (No Lambda involved, saves bandwidth)
   
4. Browser calls ingest
   ↓ POST /ingest + s3_key
   
5. Ingest Lambda
   ├─→ Downloads file from S3
   ├─→ Parses XLSX → extracts text from each sheet
   ├─→ Chunks into ~500 char segments (24 chunks)
   ├─→ For each chunk: Bedrock embeds → 1024 floats
   └─→ DynamoDB: Batch write with tenant_id
   
6. Consultant clicks "Analyze"
   ↓ POST /analyze + doc_id
   
7. Analyze Lambda
   ├─→ DynamoDB: Get all chunks for doc_id
   ├─→ DynamoDB: Get relevant KB chunks
   ├─→ Bedrock: Claude analyzes → structured JSON
   └─→ Returns: {findings: [...], risks: [...]}
```

---

## 🔑 Key Concepts Explained

### 1. **What is CDK?**

**Problem:** Manually clicking through AWS Console to create 30+ resources is error-prone and not repeatable.

**Solution:** Write TypeScript code that **describes** what you want → CDK **builds** it automatically.

**Example from `infra/lib/stack.ts`:**

```typescript
const docsBucket = new s3.Bucket(this, 'DocsBucket', {
  encryption: s3.BucketEncryption.S3_MANAGED,
  cors: [...],
});
```

**What this does:**
1. CDK converts this to CloudFormation template (AWS's infrastructure language)
2. CloudFormation creates the actual S3 bucket in your AWS account
3. Tracks all changes - if you change the code and redeploy, only modified resources update

**Running `npx cdk deploy`:**
- Bundles Lambda code in Docker containers
- Uploads assets to S3
- Creates/updates AWS resources in dependency order
- Outputs the final API endpoint and resource IDs

---

### 2. **Tenant Isolation - How It Works**

**Goal:** Acme Corp can never see Globex's data, enforced at multiple layers.

**Layer 1: Cognito JWT**
```
User logs in → Cognito returns JWT with custom claims:
{
  "email": "client-acme@example.com",
  "custom:tenant_id": "acme",
  "custom:role": "client"
}
```

**Layer 2: Lambda Extraction** (`lambdas/common/tenant.py`)
```python
def tenant_from_event(event):
    # Extract tenant_id from JWT claims
    claims = event['requestContext']['authorizer']['jwt']['claims']
    tenant_id = claims['custom:tenant_id']
    return TenantContext(tenant_id=tenant_id, ...)
```

**Layer 3: S3 Key Prefixes**
```
tenants/acme/uploads/...     ← Acme's files
tenants/globex/uploads/...   ← Globex's files
```

**Layer 4: DynamoDB Partition Key**
```python
# Query ALWAYS includes tenant_id
table.query(
    KeyConditionExpression=Key("tenant_id").eq("acme")
)
# Returns ONLY Acme's chunks - physically partitioned
```

**Layer 5: Aurora Schema-Per-Tenant**
```sql
t_acme.audit    ← Acme's audit logs
t_globex.audit  ← Globex's audit logs
```

**Layer 6: Verification After Query**
```python
for chunk in results:
    if chunk['tenant_id'] != ctx.tenant_id:
        raise RuntimeError("tenant isolation violated!")
```

---

### 3. **Vector Search - How It Works**

**Problem:** Find the most relevant chunks for a question without exact keyword matching.

**Solution:** Embeddings + Cosine Similarity

**Step-by-step:**

1. **Ingestion (happens once):**
```python
text = "Accrual frequency should align with payroll frequency"
embedding = bedrock.embed(text)
# Returns: [0.23, -0.41, 0.88, ..., 0.12]  # 1024 numbers
```

2. **Storage:**
```python
DynamoDB.put_item({
    'tenant_id': 'acme',
    'chunk_id': 'doc123#0',
    'text': 'Accrual frequency...',
    'embedding': bytes(embedding)  # Packed as binary
})
```

3. **Query (happens each chat):**
```python
question = "How should I configure accrual frequency?"
query_vector = bedrock.embed(question)
# Returns: [0.19, -0.38, 0.91, ..., 0.15]

# Get all chunks for this tenant
chunks = DynamoDB.query(tenant_id='acme')

# Rank by similarity
for chunk in chunks:
    score = cosine_similarity(query_vector, chunk.embedding)
    # If vectors point same direction → score close to 1.0
    # If perpendicular → score close to 0.0
    
# Sort by score, return top 6
```

**Why this works:** Similar meanings → similar embeddings → high cosine similarity.

---

### 4. **RAG (Retrieval-Augmented Generation)**

**Traditional chatbot:** Claude answers from memory only → hallucinates specifics about YOUR config.

**RAG approach:**
1. **Retrieve** relevant chunks from YOUR data
2. **Augment** the prompt with that context
3. **Generate** answer grounded in YOUR documents

**Example prompt sent to Claude:**

```
SYSTEM: You are a Workday coach...

USER:
<retrieved_context>
[1] source="Acme_Absence_Config.xlsx" chunk=3
Absence Plan: Annual Leave
Accrual Frequency: Monthly
...

[2] source="Workday Best Practices" chunk=0
Accrual frequency should align with payroll frequency...
</retrieved_context>

Question: How is my annual leave accrual configured?
```

**Claude's response:** Grounded in [1] and [2], cites sources, no hallucination.

---

## 🔧 What Each Lambda Does

### **1. upload_url/** - Presigned URL Generator
**Trigger:** Consultant clicks upload  
**Input:** `{filename: "Absence.xlsx"}`  
**Output:** `{url: "https://s3...", key: "tenants/acme/..."}`  
**Why it exists:** Security - Lambda has S3 write permission, frontend doesn't. Presigned URL grants one-time PUT permission.

### **2. ingest/** - Document Processor
**Trigger:** After file uploaded to S3  
**Input:** `{s3_key: "tenants/acme/...", doc_id: "uuid", module: "Absence"}`  
**Processing:**
- Downloads file from S3
- Parses XLSX → extracts each sheet as text
- Chunks into ~500 char segments
- Embeds each chunk via Bedrock (1024 dimensions)
- Batch writes to DynamoDB with tenant_id
**Output:** `{chunks_indexed: 24}`

### **3. analyze/** - AI Risk Analysis
**Trigger:** Consultant clicks "Analyze"  
**Input:** `{doc_id: "uuid", focus: "all"}`  
**Processing:**
- Loads all chunks for doc_id from DynamoDB
- Retrieves relevant KB best practices
- Sends to Claude with analysis prompt
- Claude returns structured JSON: `{findings: [], risks: [], recommendations: []}`
**Output:** Structured findings

### **4. chat/** - RAG Q&A
**Trigger:** Client asks question  
**Input:** `{message: "How does accrual work?", history: [...]}`  
**Processing:**
- Embeds question
- Queries DynamoDB for tenant's chunks
- Ranks by cosine similarity → top 6
- Builds prompt with context
- Claude generates grounded answer
**Output:** `{answer: "...", citations: [...]}`

---

## 🗄️ Data Storage Explained

### **S3 (Document Storage)**
```
workdayaiplatformstack-docsbucketecea003f-xxx/
└── tenants/
    ├── acme/
    │   └── uploads/
    │       └── uuid/
    │           └── Absence_Config.xlsx
    └── globex/
        └── uploads/
            └── ...
```
**Why:** Cheap, unlimited, versioned, direct browser upload via presigned URLs.

### **DynamoDB (Vector Storage)**
```
Table: workday-ai-vectors
Partition Key: tenant_id
Sort Key: chunk_id

Item Example:
{
  tenant_id: "acme",
  chunk_id: "doc123#5",
  doc_id: "doc123",
  doc_type: "config-workbook",
  module: "Absence",
  source_name: "Acme_Absence_Config.xlsx",
  chunk_index: 5,
  text: "Annual Leave accrual is monthly...",
  embedding: <1024 floats as binary>,
  created_at: "2026-04-18T12:00:00Z"
}
```
**Why DynamoDB:** Free tier friendly, fast partition-key queries, no subscription required (unlike OpenSearch).

**Global Secondary Index:**
```
Index: doc_id-index
Partition Key: doc_id
Use: Load all chunks for a specific document
```

### **Aurora Postgres (Metadata & Audit)**
```
Database: platform

Schemas:
- t_acme
  └── audit (id, kind, prompt, response, model_id, latency_ms, created_at)
- t_globex
  └── audit (...)
```
**Why Aurora:** Relational queries, JSON support, automatic backups, scales to zero.

---

## 🔐 Security & Permissions

### **IAM Role (Lambda Execution Role)**
```typescript
lambdaRole.addToPolicy(
  new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: ['arn:aws:bedrock:*::foundation-model/anthropic.claude-*'],
  })
);
```
**What this means:** Lambdas can call Bedrock, but nothing else can unless explicitly granted.

### **API Gateway JWT Authorizer**
```typescript
const authorizer = new apigwv2_authorizers.HttpJwtAuthorizer(
  'JwtAuthorizer',
  `https://cognito-idp.us-east-1.amazonaws.com/${userPoolId}`,
  { jwtAudience: [userPoolClientId] }
);
```
**What this does:** Every API request must include valid JWT from Cognito. Invalid token → 401 Unauthorized.

### **VPC (Network Isolation)**
```
Public Subnet:  NAT Gateway (internet access for private subnet)
Private Subnet: Lambda, Aurora (NOT directly accessible from internet)
```
**Why:** Even if someone gets Lambda code, they can't directly access the database from outside AWS.

---

## 💰 Cost Breakdown

**Free Tier (First 12 months):**
- Lambda: 1M requests/month free
- DynamoDB: 25 GB + 25 WCU/RCU free
- S3: 5 GB free
- Cognito: 50K MAU free

**Paid (After free tier or over limits):**
- **NAT Gateway:** ~$32/month (always running) ← BIGGEST COST
- **Aurora Serverless:** ~$10-20/month (scales with usage, goes to near-zero when idle)
- **Bedrock (Claude Sonnet 4):**
  - Input: ~$3 per 1M tokens
  - Output: ~$15 per 1M tokens
  - Your demo usage: ~$2-5/month
- **DynamoDB:** ~$1.25 per million writes (on-demand)
- **Lambda:** ~$0.20 per 1M requests + compute time

**Total for demo (active use):** ~$50-70/month  
**If you delete after testing:** ~$0 (just Bedrock usage charges)

---

## 🛠️ How to Make Changes

### **Add a new API endpoint:**

1. **Create Lambda handler** in `lambdas/new_endpoint/handler.py`
2. **Update stack.ts:**
```typescript
const newFn = makeFn('NewFn', 'new_endpoint', 30);
httpApi.addRoutes({
  path: '/new-endpoint',
  methods: [apigwv2.HttpMethod.POST],
  integration: new apigwv2_integrations.HttpLambdaIntegration('NewInt', newFn),
  authorizer,
});
```
3. **Deploy:** `npx cdk deploy`

### **Change AI model:**

1. **Update stack.ts:**
```typescript
const GENERATION_MODEL_ID = 'global.anthropic.claude-sonnet-4.5-v1:0';
```
2. **Deploy:** `npx cdk deploy`
3. All Lambdas automatically get new env var

### **Add a new DynamoDB field:**

1. **Update `lambdas/common/dynamo_vectors.py`:**
```python
item = {
    ...existing fields...,
    "new_field": value,
}
```
2. **Deploy:** `npx cdk deploy`
3. New ingestions will include the field

---

## 🐛 Debugging Guide

### **Chat returns 500 error:**
```bash
# Check Lambda logs
aws logs tail /aws/lambda/WorkdayAiPlatformStack-ChatFn... --follow

# Common issues:
# - Bedrock model not enabled → Enable in Bedrock console
# - DynamoDB permission denied → Check IAM role
# - Timeout → Increase timeout in stack.ts
```

### **Upload fails with 403:**
```bash
# Check presigned URL generation
aws logs tail /aws/lambda/WorkdayAiPlatformStack-UploadUrlFn... --follow

# Common issues:
# - CORS not configured → Add to S3 bucket in stack.ts
# - ContentType mismatch → Check upload_url/handler.py
```

### **Frontend can't connect:**
```bash
# Check .env.local
cat frontend/.env.local

# Should have:
VITE_API_ENDPOINT=https://xxx.execute-api.us-east-1.amazonaws.com
VITE_USER_POOL_ID=us-east-1_xxx
VITE_USER_POOL_CLIENT_ID=xxx
```

---

## 📚 Next Steps for Production

1. **Custom Domain:** Route53 + ACM certificate + CloudFront
2. **Multi-Environment:** dev, staging, prod stacks
3. **CI/CD:** GitHub Actions auto-deploy on merge
4. **Monitoring:** CloudWatch dashboards, alerts
5. **Backup:** Enable point-in-time recovery on DynamoDB
6. **Cost Optimization:** Remove NAT Gateway, use VPC endpoints

---

## 🎓 Learning Resources

**AWS CDK:**
- https://docs.aws.amazon.com/cdk/
- Concept: Infrastructure as Code

**Amazon Bedrock:**
- https://docs.aws.amazon.com/bedrock/
- Concept: Managed AI models (Claude, Titan)

**Vector Databases:**
- https://www.pinecone.io/learn/vector-database/
- Concept: Semantic search via embeddings

**RAG:**
- https://docs.anthropic.com/claude/docs/guide-to-retrieval-augmented-generation
- Concept: Grounding AI in your documents

---

**Questions?** Add them to this file as you learn!
