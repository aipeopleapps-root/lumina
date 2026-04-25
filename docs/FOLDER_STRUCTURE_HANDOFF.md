📍 Project Context
Platform: Workday Insight Studio (AI-Powered Workday Advisory by Green Dot)
Location: /Users/aashish/Downloads/workday-ai-platform
GitHub: https://github.com/aipeopleapps-root/workday-consulting-ai-platform
Live URL: https://main.d2jd92e8asbd1j.amplifyapp.com
Tech Stack:

Frontend: React + TypeScript + Vite + Tailwind
Backend: Python Lambdas on AWS
Database: DynamoDB (vectors) + Aurora Postgres (metadata)
AI: Claude Sonnet 4 via AWS Bedrock


✅ What's Already Working
Three Role-Based Portals:

Admin Portal (Control Center) - View clients, create clients/users, full tenant isolation
Consultant Portal (Analysis Workbench) - Upload & analyze Workday files
Client Portal - AI chat with citations, document library (currently flat list - needs folders!)

Infrastructure:

✅ 10+ Lambda functions deployed
✅ API Gateway with JWT auth
✅ Cognito user pool
✅ DynamoDB + Aurora Serverless v2
✅ S3 for documents
✅ GitHub Actions + Amplify CI/CD

Test Credentials:

Admin: admin@workday-ai.com / AdminPass789!
Consultant: consultant-acme@example.com / TempPass123!
Client: client-acme@example.com / TempPass123!


🎯 Feature Goal: Configurable Folder Structure
Transform flat document list into hierarchical folder explorer where:

Admin chooses folder template when creating client (Standard/Minimal/Financial)
Consultant uploads to specific folders within the structure
Client browses documents in organized tree view (read-only)

Why This Matters:

Professional UX (file explorer, not flat dump)
Scalable (new templates via config file, no code changes)
Industry-specific (different templates for HCM vs Financials)


📋 Implementation Overview
Phase 1: Configuration System (30-45 min)

Create config/folder-templates.json with 3 templates
Add database columns for template storage
Create Lambda to fetch available templates
Update admin create-tenant Lambda to store template choice
Update CDK to bundle config file with Lambdas

Phase 2: Frontend Admin Portal (45-60 min)

Create FolderTemplateSelector component with preview
Update AdminPanel to include template selector in create client modal

Phase 3: Document Storage with Folders (45-60 min)

Update ingest Lambda to store folder_path in DynamoDB
Create FileExplorer component (expandable tree view)
Create FolderPicker component (for upload destination selector)
Update ConsultantPanel with folder picker
Update DocumentsPanel to use FileExplorer instead of flat list

Phase 4: Backend Folder Endpoints (30 min)

Create Lambda to return tenant's folder structure
Update documents list Lambda to include folder_path field
Add routes to CDK stack


🎯 Quick Start Message for Claude Code
Copy this into Claude Code when you start:
Hi! I need to implement a configurable folder structure feature for my Workday AI platform.

PROJECT: /Users/aashish/Downloads/workday-ai-platform

CONTEXT:
I have a working multi-tenant Workday consulting platform with admin/consultant/client portals.
Documents are currently stored in a flat list. I want to add hierarchical folder structures.

FEATURE SPEC:
Please read docs/FOLDER_STRUCTURE_HANDOFF.md for complete details.

IMPLEMENTATION PLAN:
1. Create config/folder-templates.json with 3 folder templates
2. Add database migration for folder_structure_template column
3. Create backend Lambdas (admin_get_templates, tenant_folder_structure)
4. Create frontend components (FolderTemplateSelector, FolderPicker, FileExplorer)
5. Update existing components to use folders

Let's start with Phase 1: creating the config file.
Can you create config/folder-templates.json with the standard, minimal, and financial templates?

📦 Key Files Summary
New Files to Create:
config/folder-templates.json
migrations/002_add_folder_structure.sql
lambdas/admin_get_templates/handler.py
lambdas/admin_get_templates/requirements.txt
lambdas/tenant_folder_structure/handler.py
lambdas/tenant_folder_structure/requirements.txt
frontend/src/components/FolderTemplateSelector.tsx
frontend/src/components/FolderPicker.tsx
frontend/src/components/FileExplorer.tsx
Files to Modify:
infra/lib/stack.ts (add 2 new Lambdas, 2 new routes, update bundling)
lambdas/admin_create_tenant/handler.py (accept + store template choice)
lambdas/ingest/handler.py (accept + store folder_path)
lambdas/documents_list/handler.py (return folder_path in response)
frontend/src/components/AdminPanel.tsx (add FolderTemplateSelector)
frontend/src/components/ConsultantPanel.tsx (add FolderPicker for upload)
frontend/src/components/DocumentsPanel.tsx (replace list with FileExplorer)

🧪 Testing Checklist
After implementation, test:

 Admin can select template when creating client
 Admin can preview folder structure before creating
 Consultant sees folder tree when uploading
 Consultant can select destination folder
 Upload includes folder_path in DynamoDB
 Client sees hierarchical folder tree (not flat list)
 Client can expand/collapse folders
 Documents appear in correct folders
 Download works from folder view
 Different clients can have different templates


🚀 Deployment Commands
bash# Run migration
./run_migration.sh migrations/002_add_folder_structure.sql

# Deploy backend
cd infra
npx cdk deploy --require-approval never
cd ..

# Test locally
cd frontend
npm run dev

# Deploy to production
git add .
git commit -m "Add configurable folder structure feature"
git push origin main

💡 Key Design Decisions

Templates in config file (not database) - Easy to add new templates without migrations
Simple folder_path string - Store as "/Configuration Workbooks/HCM Core" in DynamoDB
Template choice per tenant - Stored in Aurora admin.tenants table
Frontend builds tree - No complex backend tree logic needed
folder_path optional - Defaults to "/" for backward compatibility


🗂️ Folder Template Examples
Standard Workday Structure:
📁 Configuration Workbooks
  └─ HCM Core, Absence, Payroll, Benefits, Recruiting, Compensation, Time Tracking, Performance
📁 Business Process Workbooks
  └─ Change Job BP, Hire BP, Terminate BP, Comp Change BP, Time Off BP, Transfer BP
📁 Integration Design
  └─ Inbound, Outbound, Core Connectors, Custom Reports
📁 Security & Access
  └─ Security Groups, Domain Security, BP Security
Minimal Workday Structure:
📁 Configuration
  └─ HCM, Payroll, Benefits
📁 Business Processes
  └─ Hire & Terminate, Job Changes, Compensation
📁 Integrations
  └─ Inbound, Outbound
Financials-Focused Structure:
📁 Chart of Accounts
  └─ COA Configuration, Ledger Setup, Worktags
📁 Business Processes
  └─ Procure to Pay, Order to Cash, Expense Management
📁 Reporting
  └─ Financial Reports, Custom Reports, Dashboards

📝 Database Schema Change
sql-- Migration: migrations/002_add_folder_structure.sql
ALTER TABLE admin.tenants 
ADD COLUMN IF NOT EXISTS folder_structure_template VARCHAR(50) DEFAULT 'standard_workday',
ADD COLUMN IF NOT EXISTS custom_folder_structure JSONB;

🔧 CDK Stack Updates Required

Add 2 new Lambda functions:

AdminGetTemplatesFn
TenantFolderStructureFn


Add 2 new API routes:

GET /admin/get-templates (admin only)
GET /tenant/folder-structure (all authenticated users)


Update makeFn bundling command to include:

typescript   `mkdir -p /asset-output/config && cp -au config/folder-templates.json /asset-output/config/`

🐛 Debugging Tips
If templates don't load:
bashaws logs tail /aws/lambda/WorkdayAiPlatformStack-AdminGetTemplatesFn* --since 5m --follow
If folder structure doesn't appear:
bashaws logs tail /aws/lambda/WorkdayAiPlatformStack-TenantFolderStructureFn* --since 5m --follow
If uploads don't include folder_path:
bashaws logs tail /aws/lambda/WorkdayAiPlatformStack-IngestFn* --since 5m --follow
Check DynamoDB item has folder_path:
bashaws dynamodb scan --table-name workday-ai-vectors --limit 1

✨ Success Criteria
Feature is complete when:

✅ Admin sees template dropdown when creating client
✅ Admin can preview folder structure
✅ Consultant sees folder picker (tree view) when uploading
✅ Documents are stored with folder_path in DynamoDB
✅ Client sees FileExplorer (tree view) instead of flat list
✅ Folders are expandable/collapsible
✅ Documents appear under correct folders
✅ Download works from folder view
✅ Different clients see different structures based on template


🎓 Learning Resources

AWS Lambda with Python: Existing lambdas/chat, lambdas/ingest patterns
React Components: Existing ConsultantPanel.tsx, DocumentsPanel.tsx patterns
CDK Patterns: infra/lib/stack.ts for Lambda/route definitions
Database Access: lambdas/common/db.py for RDS Data API examples


💬 Communication Tips for Claude Code
Good prompts:

"Create config/folder-templates.json with the three templates"
"Update AdminPanel.tsx to include the FolderTemplateSelector"
"Show me what folder_path will look like in DynamoDB"

Less helpful prompts:

"Build everything" (too vague)
"Make it work" (no specific direction)
Just file names without context

Best approach:

Work phase by phase
Test each phase before moving to next
Ask Claude Code to explain changes if unclear
