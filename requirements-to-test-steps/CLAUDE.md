# Requirements to Test Steps — Azure Build Spec

## Project overview

Build a Python FastAPI application that reads user requirements from an uploaded Excel
file, runs them through three sequential AI agents (user stories → test scenarios →
test steps), and writes the results back to a three-sheet output Excel file. The app
runs inside an Azure Container App and calls an LLM gateway for all AI work.

This is a complete greenfield build. Create every file listed in the directory
structure below. Do not stop until all files exist and the app starts cleanly.

---

## Target directory structure

Create this exact layout at the project root:

```
requirements-to-test-steps/
├── CLAUDE.md                          ← this file (already exists)
├── README.md
├── .env.example
├── .gitignore
├── Dockerfile
├── requirements.txt
├── app/
│   ├── __init__.py
│   ├── main.py                        ← FastAPI entrypoint
│   ├── config.py                      ← settings via pydantic-settings
│   ├── models.py                      ← Pydantic data models
│   ├── agents/
│   │   ├── __init__.py
│   │   ├── base.py                    ← shared LLM call wrapper
│   │   ├── user_stories.py            ← Agent 1
│   │   ├── test_scenarios.py          ← Agent 2
│   │   └── test_steps.py              ← Agent 3
│   ├── services/
│   │   ├── __init__.py
│   │   ├── excel_reader.py            ← openpyxl input parser
│   │   ├── excel_writer.py            ← openpyxl output builder
│   │   ├── blob_storage.py            ← Azure Blob Storage client
│   │   └── pipeline.py                ← orchestrates the full run
│   └── routers/
│       ├── __init__.py
│       ├── health.py
│       └── pipeline.py                ← /run and /status endpoints
├── infra/
│   ├── main.bicep                     ← Azure infrastructure as code
│   └── parameters.json
├── .github/
│   └── workflows/
│       └── deploy.yml                 ← GitHub Actions CI/CD
└── tests/
    ├── __init__.py
    ├── test_excel_reader.py
    ├── test_agents.py
    └── sample_requirements.xlsx       ← small test fixture
```

---

## Tech stack — use exactly these versions

```
python          3.12
fastapi         0.115.x
uvicorn         0.30.x
pydantic        2.x
pydantic-settings 2.x
openpyxl        3.1.x
httpx           0.27.x
azure-storage-blob  12.x
azure-identity  1.17.x
python-multipart 0.0.9
pytest          8.x
pytest-asyncio  0.23.x
```

Do not use LangChain, LangGraph, or any n8n SDK. All agent calls are plain async
HTTP calls via httpx.

---

## Environment variables

Read all config from environment variables. Create `app/config.py` using
`pydantic-settings` `BaseSettings`. Required variables:

```
LLM_GATEWAY_URL          # e.g. https://genai-dev.example.com/openai/v1/chat/completions
LLM_GATEWAY_API_KEY      # bearer token for the gateway
LLM_MODEL                # default: gpt-4o
LLM_MAX_TOKENS           # default: 4096
LLM_TIMEOUT_SECONDS      # default: 60
AZURE_STORAGE_ACCOUNT_URL  # e.g. https://mystorageacct.blob.core.windows.net
AZURE_STORAGE_INPUT_CONTAINER   # default: input-files
AZURE_STORAGE_OUTPUT_CONTAINER  # default: output-files
USE_MANAGED_IDENTITY     # default: true — if false, use AZURE_STORAGE_CONNECTION_STRING
AZURE_STORAGE_CONNECTION_STRING  # only needed when USE_MANAGED_IDENTITY=false
APP_ENV                  # local | staging | production
```

Create `.env.example` with all variables and placeholder values. Never hardcode
secrets in source code.

---

## Data models — app/models.py

Define these Pydantic v2 models:

```python
class Requirement(BaseModel):
    row_number: int
    requirement_id: str        # e.g. "REQ-001"
    requirement_text: str
    module: str | None = None  # e.g. "Workday HCM", "Payroll"
    priority: str | None = None

class UserStory(BaseModel):
    requirement_id: str
    story_id: str              # e.g. "US-001"
    as_a: str
    i_want: str
    so_that: str
    acceptance_criteria: list[str]

class TestScenario(BaseModel):
    story_id: str
    scenario_id: str           # e.g. "TS-001"
    scenario_type: Literal["Positive", "Negative"]
    title: str
    description: str
    preconditions: list[str]

class TestStep(BaseModel):
    scenario_id: str
    step_id: str               # e.g. "STEP-001"
    step_number: int
    action: str
    expected_result: str
    test_data: str | None = None

class PipelineResult(BaseModel):
    run_id: str
    input_filename: str
    status: Literal["running", "completed", "failed"]
    requirements_count: int
    user_stories: list[UserStory] = []
    test_scenarios: list[TestScenario] = []
    test_steps: list[TestStep] = []
    error_message: str | None = None
    output_blob_url: str | None = None
```

---

## Excel input format — app/services/excel_reader.py

Read the first sheet of the uploaded `.xlsx`. Expect these column headers (case
insensitive, strip whitespace):

- `Requirement ID` → requirement_id
- `Requirement` → requirement_text  
- `Module` → module (optional)
- `Priority` → priority (optional)

Rules:
- Skip blank rows
- If `Requirement ID` is empty, auto-generate: `REQ-{row_number:03d}`
- Raise `ValueError` with a descriptive message if `Requirement` column is missing
- Return `list[Requirement]`

---

## Agent system prompts

### Agent 1 — user_stories.py

System prompt (store as a module-level constant `SYSTEM_PROMPT`):

```
You are an AI assistant specialising in Workday HCM and Financial ERP implementation
and testing. Your responses MUST follow only the described desired content and MUST
NOT include any superfluous text. All text MUST be in en-AU/Commonwealth English.

## Task
Analyse the requirement text given and output EXACTLY ONE User Story.
Do NOT merge, combine, or group multiple requirements.

## Output format
Respond with ONLY valid JSON matching this schema — no markdown fences, no preamble:
{
  "story_id": "US-XXX",
  "as_a": "<role>",
  "i_want": "<goal>",
  "so_that": "<benefit>",
  "acceptance_criteria": ["<criterion 1>", "<criterion 2>", ...]
}
```

### Agent 2 — test_scenarios.py

System prompt:

```
You are an AI assistant specialising in Workday HCM and Financial ERP implementation
and testing. All text MUST be in en-AU/Commonwealth English.

## Task
Analyse the User Story JSON given and output EXACTLY TWO Test Scenarios:
1. ONE Positive scenario (happy path)
2. ONE Negative scenario (failure / edge case)

## Output format
Respond with ONLY valid JSON — no markdown fences, no preamble:
{
  "scenarios": [
    {
      "scenario_id": "TS-XXX",
      "scenario_type": "Positive",
      "title": "<short title>",
      "description": "<what is being tested>",
      "preconditions": ["<precondition 1>", ...]
    },
    {
      "scenario_id": "TS-XXX",
      "scenario_type": "Negative",
      "title": "<short title>",
      "description": "<what is being tested>",
      "preconditions": ["<precondition 1>", ...]
    }
  ]
}
```

### Agent 3 — test_steps.py

System prompt:

```
You are an AI assistant specialising in Workday HCM and Financial ERP implementation
and testing. The audience are end-clients with limited Workday experience.
All text MUST be in en-AU/Commonwealth English.

## Task
For each Test Scenario given, produce a numbered list of test steps.
Each step must be actionable and self-contained.

## Output format
Respond with ONLY valid JSON — no markdown fences, no preamble:
{
  "steps": [
    {
      "step_number": 1,
      "action": "<what the tester does>",
      "expected_result": "<what should happen>",
      "test_data": "<any specific data values or null>"
    },
    ...
  ]
}
```

---

## LLM call wrapper — app/agents/base.py

Implement `async def call_llm(system_prompt: str, user_message: str, settings: Settings) -> dict`:

- POST to `settings.LLM_GATEWAY_URL`
- Headers: `Authorization: Bearer {settings.LLM_GATEWAY_API_KEY}`, `Content-Type: application/json`
- Body: `{"model": settings.LLM_MODEL, "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_message}], "max_tokens": settings.LLM_MAX_TOKENS, "response_format": {"type": "json_object"}}`
- Use `httpx.AsyncClient` with `timeout=settings.LLM_TIMEOUT_SECONDS`
- On HTTP 429, retry with exponential backoff: 3 attempts, delays 2s / 4s / 8s
- On any other non-2xx, raise `RuntimeError(f"LLM gateway error {status}: {body}")`
- Parse the response content field and `json.loads` it — return the dict
- Log the request duration and token usage (if present in response) at DEBUG level

---

## Pipeline orchestration — app/services/pipeline.py

Implement `async def run_pipeline(requirements: list[Requirement], run_id: str, settings: Settings) -> PipelineResult`:

1. For each requirement, call Agent 1 concurrently using `asyncio.gather` (max 5 concurrent via `asyncio.Semaphore(5)`)
2. Assign sequential IDs: US-001, US-002, …
3. For each user story, call Agent 2 concurrently (same semaphore limit)
4. Assign sequential scenario IDs: TS-001, TS-002, …
5. For each scenario, call Agent 3 concurrently (same semaphore limit)
6. Assign sequential step IDs: STEP-001-001, STEP-001-002, … (scenario_id + step_number)
7. Assemble into `PipelineResult`
8. Log progress at each stage: "Stage 1/3: generating user stories for N requirements"

---

## Excel output — app/services/excel_writer.py

Build a workbook with exactly three sheets:

**Sheet 1 — "User Stories"**
Columns: `Story ID` | `Requirement ID` | `As a` | `I want` | `So that` | `Acceptance Criteria`
(Acceptance criteria joined with ` | `)

**Sheet 2 — "Test Scenarios"**
Columns: `Scenario ID` | `Story ID` | `Type` | `Title` | `Description` | `Preconditions`
(Preconditions joined with ` | `)

**Sheet 3 — "Test Steps"**
Columns: `Step ID` | `Scenario ID` | `Step #` | `Action` | `Expected Result` | `Test Data`

Formatting rules:
- Header row: bold, background colour `#1F4E79` (dark blue), font colour white
- Alternate row shading: every other data row uses `#D9E1F2` (light blue)
- Column widths: auto-fit to content (calculate max character length per column, cap at 80)
- Freeze top row on each sheet
- Return the workbook as `bytes` (use `io.BytesIO`)

---

## API endpoints — app/routers/pipeline.py

### POST /run
- Accepts multipart form: `file: UploadFile` (must be `.xlsx`)
- Generates a `run_id` (UUID4)
- Reads the Excel file using `excel_reader`
- Calls `run_pipeline`
- Writes the output Excel to Azure Blob Storage (`output-container/{run_id}/results.xlsx`)
- Returns:
```json
{
  "run_id": "uuid",
  "status": "completed",
  "requirements_count": 12,
  "output_blob_url": "https://...",
  "summary": {
    "user_stories": 12,
    "test_scenarios": 24,
    "test_steps": 148
  }
}
```
- On any error, return HTTP 500 with `{"error": "<message>", "run_id": "uuid"}`

### GET /health
Returns `{"status": "ok", "version": "1.0.0"}`

---

## Blob Storage — app/services/blob_storage.py

Implement two functions:

```python
async def upload_bytes(data: bytes, blob_name: str, container: str, settings: Settings) -> str:
    # returns the blob URL

async def download_bytes(blob_name: str, container: str, settings: Settings) -> bytes:
    # returns raw bytes
```

Auth logic:
- If `settings.USE_MANAGED_IDENTITY` is `True`, use `DefaultAzureCredential()`
- Otherwise use `BlobServiceClient.from_connection_string(settings.AZURE_STORAGE_CONNECTION_STRING)`
- All operations must be async (use the async azure-storage-blob client)

---

## Dockerfile

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

---

## Azure infrastructure — infra/main.bicep

Create a Bicep file that provisions:

1. **Storage Account** (Standard_LRS, StorageV2)
   - Two blob containers: `input-files` and `output-files`
2. **Container Registry** (Basic SKU)
3. **Container Apps Environment** (Consumption tier)
4. **Container App**
   - Image: `{acrLoginServer}/req-to-test:latest`
   - CPU: 0.5, Memory: 1Gi
   - Min replicas: 1, Max replicas: 5
   - Ingress: external, port 8000
   - System-assigned managed identity enabled
   - All environment variables referenced as secrets from the container's secret store
5. **Role assignment**: assign `Storage Blob Data Contributor` to the Container App's
   managed identity on the Storage Account

Parameters: `location`, `appName`, `acrLoginServer`, `llmGatewayUrl`, `llmGatewayApiKey`

---

## GitHub Actions — .github/workflows/deploy.yml

Trigger: push to `main` branch

Steps:
1. Checkout
2. Log in to Azure using `azure/login@v2` (service principal via `AZURE_CREDENTIALS` secret)
3. Log in to ACR using `azure/docker-login@v2`
4. Build and push Docker image tagged `{acrLoginServer}/req-to-test:${{ github.sha }}` and `:latest`
5. Deploy to Container App using `azure/container-apps-deploy-action@v2`

Required GitHub secrets: `AZURE_CREDENTIALS`, `ACR_LOGIN_SERVER`

---

## Tests — tests/

### tests/test_excel_reader.py
- Test happy path: reads all columns correctly
- Test auto-generated requirement IDs when column is absent
- Test raises `ValueError` when `Requirement` column is missing
- Test skips blank rows

### tests/test_agents.py
- Mock `call_llm` using `pytest-asyncio` and `unittest.mock.AsyncMock`
- Test Agent 1 returns a correctly structured `UserStory`
- Test Agent 2 returns exactly 2 scenarios (one positive, one negative)
- Test Agent 3 returns steps with sequential step numbers
- Test that the retry logic fires on a 429 response

### tests/sample_requirements.xlsx
Generate this file programmatically in a `conftest.py` fixture using openpyxl.
Include 3 sample rows with columns: Requirement ID, Requirement, Module, Priority.

---

## README.md

Write a README that covers:
1. Architecture overview (3 sentences)
2. Local development setup (clone → create `.env` from `.env.example` → `pip install` → `uvicorn`)
3. How to run tests: `pytest tests/`
4. How to upload a requirements file: `curl` example against `/run`
5. Azure deployment: point to `infra/main.bicep` and the GitHub Actions workflow
6. Expected Excel input column names
7. Output Excel sheet descriptions

---

## Build instructions for Claude Code

Execute these steps in order. Do not proceed to the next step until the current
one completes without errors.

### Step 1 — Scaffold the directory structure
Create all directories and empty `__init__.py` files.

### Step 2 — Create config and models
Build `app/config.py` and `app/models.py` first — everything else imports from them.

### Step 3 — Build the LLM base client
Create `app/agents/base.py` with the `call_llm` function and retry logic.
Write a quick sanity check: `python -c "from app.agents.base import call_llm; print('OK')"`.

### Step 4 — Build all three agents
Create `app/agents/user_stories.py`, `app/agents/test_scenarios.py`,
`app/agents/test_steps.py`.

### Step 5 — Build Excel reader and writer
Create `app/services/excel_reader.py` and `app/services/excel_writer.py`.
Run `python -c "from app.services.excel_reader import read_requirements; print('OK')"`.

### Step 6 — Build Blob Storage service
Create `app/services/blob_storage.py`.

### Step 7 — Build the pipeline orchestrator
Create `app/services/pipeline.py`.

### Step 8 — Build the FastAPI app and routers
Create `app/main.py` and `app/routers/health.py` and `app/routers/pipeline.py`.

### Step 9 — Verify the app starts
Run: `uvicorn app.main:app --port 8000 --reload`
The app must start without import errors. Press Ctrl+C once confirmed.

### Step 10 — Run all tests
Run: `pytest tests/ -v`
All tests must pass. Fix any failures before continuing.

### Step 11 — Create infrastructure files
Create `infra/main.bicep` and `infra/parameters.json`.

### Step 12 — Create GitHub Actions workflow
Create `.github/workflows/deploy.yml`.

### Step 13 — Create Dockerfile and requirements.txt
Ensure `requirements.txt` pins all packages listed in the tech stack section.

### Step 14 — Final check
Run these commands in sequence and confirm each succeeds:
```bash
python -m pytest tests/ -v
uvicorn app.main:app --port 8000 &
sleep 3
curl http://localhost:8000/health
kill %1
```

---

## Coding conventions

- Use Python type hints on every function signature
- Use `async def` for all I/O-bound functions (HTTP calls, file operations, blob operations)
- Use `logging.getLogger(__name__)` — never `print()` in production code
- Pydantic v2 syntax: `model_validate`, `model_dump` — not v1 `parse_obj` / `dict()`
- All agent JSON parsing must use `try/except json.JSONDecodeError` with a clear
  error message indicating which agent failed and what the raw response was
- Keep each file under 200 lines; split into helpers if longer
- No hardcoded strings except the agent system prompts (which are constants)

---

## What NOT to build

- No frontend or HTML UI — API only
- No database — state lives in memory per request and in Blob Storage
- No authentication on the API endpoints — assume network-level security
- No Docker Compose — the Dockerfile is for Azure Container Registry only
- No LangChain, semantic kernel, or other AI frameworks
