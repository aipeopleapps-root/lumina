# VS Code Setup Guide

This guide helps you set up VS Code for optimal development with this project.

---

## 📦 Recommended Extensions

Install these extensions for the best development experience:

### Essential

1. **Python** (`ms-python.python`)
   - Linting, debugging, IntelliSense for Lambda functions
   
2. **TypeScript and JavaScript Language Features** (built-in)
   - For CDK infrastructure code

3. **ESLint** (`dbaeumer.vscode-eslint`)
   - Frontend code linting

4. **Prettier** (`esbenp.prettier-vscode`)
   - Code formatting

### AWS Development

5. **AWS Toolkit** (`amazonwebservices.aws-toolkit-vscode`)
   - Interact with AWS services directly from VS Code
   - View Lambda logs, S3 buckets, DynamoDB tables

6. **CloudFormation Linter** (`kddejong.vscode-cfn-lint`)
   - Validates CDK-generated CloudFormation

### Nice to Have

7. **GitLens** (`eamodio.gitlens`)
   - Enhanced Git capabilities

8. **Error Lens** (`usernamehw.errorlens`)
   - Inline error messages

9. **Path Intellisense** (`christian-kohler.path-intellisense`)
   - Autocomplete file paths

10. **Todo Tree** (`gruntfuggly.todo-tree`)
    - Highlights TODO, FIXME comments

---

## ⚙️ Workspace Settings

Create `.vscode/settings.json`:

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  },
  "python.linting.enabled": true,
  "python.linting.pylintEnabled": true,
  "python.formatting.provider": "black",
  "python.defaultInterpreterPath": "/opt/homebrew/bin/python3",
  "[typescript]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode"
  },
  "[python]": {
    "editor.formatOnSave": true,
    "editor.defaultFormatter": "ms-python.python"
  },
  "files.exclude": {
    "**/__pycache__": true,
    "**/*.pyc": true,
    "**/.DS_Store": true,
    "**/node_modules": true,
    "infra/cdk.out": true
  },
  "search.exclude": {
    "**/node_modules": true,
    "**/dist": true,
    "infra/cdk.out": true
  }
}
```

**To create this:**

```bash
mkdir -p .vscode
cat > .vscode/settings.json << 'EOF'
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "python.linting.enabled": true,
  "python.linting.pylintEnabled": true,
  "python.formatting.provider": "black",
  "[typescript]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode"
  },
  "[python]": {
    "editor.formatOnSave": true
  },
  "files.exclude": {
    "**/__pycache__": true,
    "**/*.pyc": true,
    "**/node_modules": true,
    "infra/cdk.out": true
  }
}
EOF
```

---

## 🔍 Understanding the File Explorer

When you open the project in VS Code, you'll see:

```
📁 workday-ai-platform/
├── 📁 docs/                    # Architecture diagrams
├── 📁 frontend/                # React app
│   ├── 📁 src/
│   │   ├── 📁 components/      # UI components
│   │   ├── 📁 lib/            # Utilities
│   │   └── 📄 App.tsx         # Main app
│   ├── 📄 .env.local          # Frontend config (gitignored)
│   └── 📄 package.json        # Dependencies
├── 📁 infra/                   # AWS CDK
│   ├── 📁 lib/
│   │   └── 📄 stack.ts        # ⭐ MAIN INFRASTRUCTURE FILE
│   ├── 📁 bin/
│   │   └── 📄 app.ts          # CDK entry point
│   └── 📄 package.json        # CDK dependencies
├── 📁 lambdas/                 # Backend functions
│   ├── 📁 common/             # Shared utilities
│   │   ├── 📄 tenant.py       # Tenant isolation
│   │   ├── 📄 bedrock.py      # AI calls
│   │   └── 📄 dynamo_vectors.py  # Vector search
│   ├── 📁 upload_url/         # Presigned URL generator
│   ├── 📁 ingest/             # Document processor
│   ├── 📁 analyze/            # AI analysis
│   └── 📁 chat/               # RAG Q&A
├── 📁 seed-data/              # Demo data scripts
├── 📄 .gitignore              # What NOT to commit
├── 📄 PROJECT_GUIDE.md        # ⭐ READ THIS FIRST
├── 📄 DEPLOYMENT.md           # Production deployment
└── 📄 README.md               # Quick start
```

---

## 🎯 Key Files to Understand

### **Infrastructure (TypeScript)**

**`infra/lib/stack.ts`** - The most important file
- Defines all AWS resources (S3, DynamoDB, Lambda, etc.)
- Changes here = changes to your AWS infrastructure
- ~230 lines of code that creates 30+ AWS resources

**`infra/bin/app.ts`** - Entry point
- Instantiates the stack
- Run via `npx cdk deploy`

### **Backend (Python)**

**`lambdas/common/tenant.py`** - Tenant isolation
- Extracts tenant_id from JWT
- Enforces access control
- Used by every Lambda

**`lambdas/common/bedrock.py`** - AI integration
- Calls Claude for text generation
- Calls Titan for embeddings
- Handles rate limiting, retries

**`lambdas/chat/handler.py`** - Main chat logic
- Receives question
- Searches vectors
- Generates grounded answer

### **Frontend (React + TypeScript)**

**`frontend/src/App.tsx`** - Main component
- Routing
- Authentication
- Persona switching (consultant vs client)

**`frontend/src/lib/api.ts`** - API client
- Calls backend endpoints
- Handles JWT tokens
- Error handling

---

## 🛠️ Common Development Tasks

### **1. Run Frontend Locally**

```bash
# Terminal 1
cd frontend
npm run dev

# Opens http://localhost:5173
```

### **2. Deploy Infrastructure Changes**

```bash
# Terminal 2
cd infra
npx cdk diff   # Preview changes
npx cdk deploy # Apply changes
```

### **3. View Lambda Logs**

**Option A: Terminal**
```bash
aws logs tail /aws/lambda/WorkdayAiPlatformStack-ChatFn... --follow
```

**Option B: VS Code AWS Toolkit**
1. Click AWS icon in left sidebar
2. Expand Lambda
3. Right-click function → View Logs

### **4. Test Lambda Function Locally**

```bash
cd lambdas/chat
python3 -c "
import handler
event = {
    'requestContext': {
        'authorizer': {
            'jwt': {
                'claims': {
                    'custom:tenant_id': 'acme',
                    'custom:role': 'client'
                }
            }
        }
    },
    'body': '{\"message\": \"test\"}'
}
print(handler.handler(event, {}))
"
```

### **5. Format Code**

```bash
# Frontend
cd frontend
npm run format

# Python (install black first)
pip install black
black lambdas/
```

---

## 🐛 Debugging in VS Code

### **Debug Frontend**

1. Open `frontend/src/App.tsx`
2. Click in the gutter to set a breakpoint (red dot)
3. Press **F5** or **Run → Start Debugging**
4. Opens Chrome in debug mode
5. App pauses at breakpoints

### **Debug CDK Stack**

Can't debug CDK directly, but you can:

```bash
# See what CDK will do
npx cdk synth > template.yaml

# Open template.yaml to see generated CloudFormation
```

### **Debug Lambda (Simulated)**

Create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Lambda",
      "type": "python",
      "request": "launch",
      "program": "${file}",
      "console": "integratedTerminal",
      "env": {
        "DOCS_BUCKET": "test-bucket",
        "VECTOR_TABLE_NAME": "test-table",
        "GENERATION_MODEL_ID": "global.anthropic.claude-sonnet-4-20250514-v1:0"
      }
    }
  ]
}
```

---

## 📝 Useful VS Code Shortcuts

### Navigation

- **Cmd+P** - Quick file open
- **Cmd+Shift+F** - Search across all files
- **Cmd+Click** - Go to definition
- **Cmd+Shift+O** - Go to symbol (function/class)

### Editing

- **Cmd+D** - Select next occurrence
- **Cmd+Shift+L** - Select all occurrences
- **Opt+Up/Down** - Move line up/down
- **Cmd+/** - Toggle comment

### Terminal

- **Ctrl+`** - Toggle terminal
- **Cmd+Shift+5** - Split terminal

### Git

- **Ctrl+Shift+G** - Open source control
- **Cmd+K Cmd+C** - Commit
- **Cmd+K Cmd+P** - Push

---

## 🔧 Troubleshooting VS Code

### **"Python not found"**

```bash
# Install Python extension
# Press Cmd+Shift+P → "Python: Select Interpreter"
# Choose /opt/homebrew/bin/python3
```

### **"Module not found" errors in Python**

```bash
# Install dependencies
cd lambdas/chat
pip install -r requirements.txt
```

### **TypeScript errors in stack.ts**

```bash
# Install dependencies
cd infra
npm install
```

### **ESLint/Prettier conflicts**

Add to `.vscode/settings.json`:
```json
{
  "prettier.eslintIntegration": true,
  "editor.formatOnSave": true
}
```

---

## 🎨 Theme Recommendations

**Dark Themes:**
- One Dark Pro
- Dracula Official
- Night Owl

**Light Themes:**
- GitHub Light
- Atom One Light

**Font:**
- Fira Code (with ligatures)
- JetBrains Mono
- Cascadia Code

---

## 📚 Next Steps

1. ✅ Open project in VS Code
2. ✅ Install recommended extensions
3. ✅ Read `PROJECT_GUIDE.md` (explains everything)
4. ⬜ Make a small change to test workflow
5. ⬜ Set up Git (see `DEPLOYMENT.md`)
6. ⬜ Push to GitHub

**You're ready to develop professionally!** 🚀
