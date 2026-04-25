cat > docs/FOLDER_STRUCTURE_HANDOFF.md << 'EOF'
# 🚀 Claude Code Handoff: Configurable Folder Structure Feature

## 📍 Project Context

**Platform:** Workday Insight Studio (AI-Powered Workday Advisory by Green Dot)  
**Location:** `/Users/aashish/Downloads/workday-ai-platform`  
**GitHub:** https://github.com/aipeopleapps-root/workday-consulting-ai-platform  
**Live URL:** https://main.d2jd92e8asbd1j.amplifyapp.com

**Tech Stack:**
- Frontend: React + TypeScript + Vite + Tailwind
- Backend: Python Lambdas on AWS
- Database: DynamoDB (vectors) + Aurora Postgres (metadata)
- AI: Claude Sonnet 4 via AWS Bedrock

---

## ✅ What's Already Working

### Three Role-Based Portals:

1. **Admin Portal (Control Center)**
   - View all clients with stats
   - Create new clients and users
   - Full tenant isolation

2. **Consultant Portal (Analysis Workbench)**
   - Upload Workday config files
   - AI-powered analysis with findings
   - Document ingestion and embedding

3. **Client Portal**
   - "Ask Workday Expert" - RAG chat with citations
   - Document library (currently flat list - **needs folder structure**)
   - Download documents

### Infrastructure:
- ✅ 10+ Lambda functions deployed
- ✅ API Gateway with JWT auth
- ✅ Cognito user pool
- ✅ DynamoDB + Aurora Serverless v2
- ✅ S3 for document storage
- ✅ GitHub Actions + Amplify CI/CD

**Test Credentials:**
- Admin: `admin@workday-ai.com` / `AdminPass789!`
- Consultant: `consultant-acme@example.com` / `TempPass123!`
- Client: `client-acme@example.com` / `TempPass123!`

---

## 🎯 Feature to Build: Configurable Folder Structure

### Goal
Transform the flat document list into a hierarchical folder explorer where:
- **Admin** chooses folder template when creating client (Standard vs Custom)
- **Consultant** uploads to specific folders within the structure
- **Client** browses documents in organized folder tree (read-only)

### Why This Matters
- Professional UX (file explorer, not flat dump)
- Scalable (new templates via config file, no code changes)
- Flexible (clients can have standard or custom structures)
- Industry-specific (different templates for HCM, Financials, Full Suite)

---

## 📋 Implementation Phases

### Phase 1: Configuration System (30-45 min)

#### 1.1 Create Folder Templates Config

**File:** `config/folder-templates.json`

```json
{
  "templates": {
    "standard_workday": {
      "id": "standard_workday",
      "name": "Standard Workday Structure",
      "description": "Recommended structure for full Workday implementations",
      "folders": [
        {
          "id": "config-workbooks",
          "name": "Configuration Workbooks",
          "icon": "⚙️",
          "subfolders": [
            { "id": "hcm-core", "name": "HCM Core", "description": "Core HCM configuration" },
            { "id": "absence", "name": "Absence Management", "description": "Leave and absence configs" },
            { "id": "payroll", "name": "Payroll", "description": "Payroll configuration" },
            { "id": "benefits", "name": "Benefits", "description": "Benefits enrollment and admin" },
            { "id": "recruiting", "name": "Recruiting", "description": "Talent acquisition configs" },
            { "id": "compensation", "name": "Compensation", "description": "Comp plans and structures" },
            { "id": "time-tracking", "name": "Time Tracking", "description": "Time and attendance" },
            { "id": "performance", "name": "Performance Management", "description": "Reviews and goals" }
          ]
        },
        {
          "id": "bp-workbooks",
          "name": "Business Process Workbooks",
          "icon": "🔄",
          "subfolders": [
            { "id": "change-job", "name": "Change Job BP", "description": "Job change processes" },
            { "id": "hire", "name": "Hire BP", "description": "Hiring and onboarding" },
            { "id": "terminate", "name": "Terminate BP", "description": "Termination processes" },
            { "id": "comp-change", "name": "Request Compensation Change BP", "description": "Comp change requests" },
            { "id": "time-off", "name": "Request Time Off BP", "description": "PTO request processes" },
            { "id": "transfer", "name": "Transfer BP", "description": "Internal transfers" }
          ]
        },
        {
          "id": "integrations",
          "name": "Integration Design",
          "icon": "🔌",
          "subfolders": [
            { "id": "inbound", "name": "Inbound Integrations", "description": "Data coming into Workday" },
            { "id": "outbound", "name": "Outbound Integrations", "description": "Data leaving Workday" },
            { "id": "connectors", "name": "Core Connectors", "description": "Pre-built connectors" },
            { "id": "reports", "name": "Custom Reports", "description": "RaaS and custom reporting" }
          ]
        },
        {
          "id": "security",
          "name": "Security & Access",
          "icon": "🔒",
          "subfolders": [
            { "id": "security-groups", "name": "Security Groups", "description": "Security group definitions" },
            { "id": "domain-security", "name": "Domain Security", "description": "Domain security policies" },
            { "id": "bp-security", "name": "Business Process Security", "description": "BP security configs" }
          ]
        }
      ]
    },
    
    "minimal_workday": {
      "id": "minimal_workday",
      "name": "Minimal Workday Structure",
      "description": "Simplified structure for smaller implementations",
      "folders": [
        {
          "id": "configuration",
          "name": "Configuration",
          "icon": "⚙️",
          "subfolders": [
            { "id": "hcm", "name": "HCM" },
            { "id": "payroll", "name": "Payroll" },
            { "id": "benefits", "name": "Benefits" }
          ]
        },
        {
          "id": "business-processes",
          "name": "Business Processes",
          "icon": "🔄",
          "subfolders": [
            { "id": "hire-terminate", "name": "Hire & Terminate" },
            { "id": "job-changes", "name": "Job Changes" },
            { "id": "compensation", "name": "Compensation" }
          ]
        },
        {
          "id": "integrations",
          "name": "Integrations",
          "icon": "🔌",
          "subfolders": [
            { "id": "inbound", "name": "Inbound" },
            { "id": "outbound", "name": "Outbound" }
          ]
        }
      ]
    },
    
    "financial_focus": {
      "id": "financial_focus",
      "name": "Financials-Focused Structure",
      "description": "For Workday Financial Management implementations",
      "folders": [
        {
          "id": "coa",
          "name": "Chart of Accounts",
          "icon": "💰",
          "subfolders": [
            { "id": "coa-config", "name": "COA Configuration" },
            { "id": "ledger", "name": "Ledger Setup" },
            { "id": "worktags", "name": "Worktags" }
          ]
        },
        {
          "id": "business-processes",
          "name": "Business Processes",
          "icon": "🔄",
          "subfolders": [
            { "id": "p2p", "name": "Procure to Pay" },
            { "id": "o2c", "name": "Order to Cash" },
            { "id": "expense", "name": "Expense Management" }
          ]
        },
        {
          "id": "reporting",
          "name": "Reporting",
          "icon": "📊",
          "subfolders": [
            { "id": "financial-reports", "name": "Financial Reports" },
            { "id": "custom-reports", "name": "Custom Reports" },
            { "id": "dashboards", "name": "Dashboards" }
          ]
        }
      ]
    }
  }
}
```

#### 1.2 Database Migration

**File:** `migrations/002_add_folder_structure.sql`

```sql
-- Add folder structure columns to tenants table
ALTER TABLE admin.tenants 
ADD COLUMN IF NOT EXISTS folder_structure_template VARCHAR(50) DEFAULT 'standard_workday',
ADD COLUMN IF NOT EXISTS custom_folder_structure JSONB;

COMMENT ON COLUMN admin.tenants.folder_structure_template IS 'Template ID from folder-templates.json, or "custom" for custom structure';
COMMENT ON COLUMN admin.tenants.custom_folder_structure IS 'Custom folder definition if template is "custom"';
```

**Run migration:**
```bash
./run_migration.sh migrations/002_add_folder_structure.sql
```

#### 1.3 Admin Get Templates Lambda

**File:** `lambdas/admin_get_templates/handler.py`

```python
"""
Admin: Get available folder structure templates
"""
import json
import logging
import os

from common import tenant_from_event, TenantError, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

TEMPLATES_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "config", "folder-templates.json")

def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        with open(TEMPLATES_PATH, "r") as f:
            templates_data = json.load(f)
        
        templates = list(templates_data["templates"].values())
        return http.ok({"templates": templates})
        
    except Exception as e:
        log.error("Failed to load templates: %s", e, exc_info=True)
        return http.error("Failed to load folder templates")
```

**File:** `lambdas/admin_get_templates/requirements.txt`
