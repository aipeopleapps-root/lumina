# Requirements to Test Steps

## Architecture Overview

This FastAPI application accepts an Excel file of software requirements and processes them through three sequential AI agents: Agent 1 converts each requirement into a structured user story, Agent 2 generates one positive and one negative test scenario per user story, and Agent 3 produces detailed, numbered test steps for each scenario. The results are written to a formatted three-sheet Excel output file stored in Azure Blob Storage, and the app is deployed as an Azure Container App that authenticates to storage via a system-assigned managed identity.

## Local Development Setup

```bash
# 1. Clone the repository
git clone <repo-url>
cd requirements-to-test-steps

# 2. Create your local .env file
cp .env.example .env
# Edit .env and fill in LLM_GATEWAY_URL, LLM_GATEWAY_API_KEY, etc.

# 3. Install dependencies
pip install -r requirements.txt

# 4. Start the app
uvicorn app.main:app --reload --port 8000
```

The API will be available at `http://localhost:8000`.  
Interactive docs (Swagger UI): `http://localhost:8000/docs`

## Running Tests

```bash
pytest tests/ -v
```

All tests use mocked LLM calls — no real gateway connection is required.

## Uploading a Requirements File

```bash
curl -X POST http://localhost:8000/run \
  -F "file=@/path/to/your/requirements.xlsx" \
  -H "Accept: application/json"
```

The response includes the `output_blob_url` pointing to the generated Excel file in Azure Blob Storage.

## Azure Deployment

### Infrastructure provisioning

Deploy the Bicep template to create all required Azure resources:

```bash
az deployment group create \
  --resource-group <your-resource-group> \
  --template-file infra/main.bicep \
  --parameters infra/parameters.json \
  --parameters llmGatewayApiKey=<your-api-key>
```

### CI/CD

Push to the `main` branch to trigger the GitHub Actions workflow (`.github/workflows/deploy.yml`), which builds and pushes the Docker image to ACR and deploys it to the Container App.

Required GitHub secrets:
- `AZURE_CREDENTIALS` — service principal JSON from `az ad sp create-for-rbac`
- `ACR_LOGIN_SERVER` — e.g. `myacr.azurecr.io`
- `AZURE_RESOURCE_GROUP` — name of the target resource group

## Expected Excel Input Format

Your input `.xlsx` file must have the following columns in the first sheet (headers are case-insensitive):

| Column | Required | Description |
|---|---|---|
| `Requirement ID` | Optional | e.g. `REQ-001`. Auto-generated if empty. |
| `Requirement` | **Required** | The full requirement text. |
| `Module` | Optional | e.g. `Workday HCM`, `Payroll`. |
| `Priority` | Optional | e.g. `High`, `Medium`, `Low`. |

Blank rows are skipped automatically.

## Output Excel Sheet Descriptions

The output workbook contains three sheets:

| Sheet | Columns |
|---|---|
| **User Stories** | Story ID, Requirement ID, As a, I want, So that, Acceptance Criteria |
| **Test Scenarios** | Scenario ID, Story ID, Type (Positive/Negative), Title, Description, Preconditions |
| **Test Steps** | Step ID, Scenario ID, Step #, Action, Expected Result, Test Data |

Each sheet has a bold dark-blue header row, alternating light-blue row shading, auto-fitted column widths, and frozen top row for easy navigation.
