# Workday Agent System of Record (ASOR) — Technical Whitepaper

## The strategic imperative for a digital workforce system of record

As global enterprises increasingly integrate AI agents into their core operations, a fundamental shift is occurring from human-centric workflows to collaborative human-agent ecosystems. This whitepaper provides an exhaustive technical examination of the Workday Agent System of Record (ASOR), the enterprise-grade governance platform engineered to manage the lifecycle, security, and performance of the blended workforce.

Drawing upon the architectural principles of the Workday Extend platform, this document details the ASOR architecture, platform services, security protocols, and integration patterns required to support First-Party (1P) and Third-Party (3P) Agents. It dissects the technical mechanisms of the Agent Gateway (AG), the Object Management Server (OMS) integrations, and the rigorous authentication flows — specifically Delegate and Ambient modes — that ensure data integrity and compliance across the Workday ecosystem.

### The emergence of the blended workforce

This transition introduces a new class of entity within the enterprise: the digital worker. Unlike passive software tools or simple automation scripts (RPA) that perform repetitive tasks, AI agents possess the autonomy to reason, plan, and execute tasks across disparate systems. They can analyze financial data, source talent, and optimize supply chains with minimal human intervention. While this autonomy promises unparalleled gains in productivity and operational efficiency, it simultaneously introduces significant risks regarding governance, security, and data lineage.

### The challenge of agent sprawl and shadow AI

As organizations deploy agents to solve specific departmental problems — ranging from financial auditing to talent acquisition — they face the immediate and pressing risk of "agent sprawl": the uncontrolled proliferation of disparate agent technologies, leading to fragmented AI silos and shadow IT scenarios where digital workers operate without central oversight. Without a unified system of record, organizations lack the capability to establish accountability (attributing specific actions to a specific agent instance or version), measure ROI (inconsistent performance metrics across different agent platforms), or ensure compliance (uniform security, privacy, and ethical guidelines across fragmented data sources).

### The Workday solution: Agent System of Record

ASOR is engineered to address these challenges by providing a centralized, authoritative platform to register, configure, manage, and measure the entire fleet of AI agents — regardless of whether they are built by Workday, partners, or the customers themselves. ASOR extends the foundational capabilities of Workday as the system of record for the human workforce to the digital workforce, leveraging the "Power of One" data model to ensure a unified source of truth for identity and performance.

## Architecture overview

### The Object Management Server foundation

At the heart of the ASOR architecture is the Workday Object Management Server (OMS) — a cluster of services that acts as an in-memory database and hosts the business logic for all Workday products. Unlike traditional relational database architectures that rely on thousands of static tables, the OMS utilizes a metadata-driven object model, allowing dynamic definition of business objects, relationships, and processing rules without requiring database restructuring.

For ASOR, the OMS provides:
- **Identity persistence**: stores the Agent System User (ASU) and Agent Delegation Account identities — the digital equivalents of user profiles for agents.
- **Security context**: evaluates security permissions in real time, checking if a specific ASU has the authority to invoke a skill or tool, based on the Workday security model.
- **Token management**: functions as the authority for issuing "on behalf of" tokens, validating user sessions, and managing the lifecycle of authentication credentials.

The OMS treats the underlying SQL database primarily as a key-value store for backup and recovery, performing active processing in memory to ensure the speed required for conversational AI and real-time agent reasoning.

### High-level component architecture

- **ASOR Registry**: located logically within the OMS, the master database of all agent definitions — the current list of all defined agents, their versions, configured skills, and active status within a specific tenant.
- **Agent Gateway (AG)**: the central traffic controller and ingress point for all agentic requests. Abstracts the complexity of the underlying infrastructure from the client (Workday UI, Slack bot, or external API). Responsible for request routing (directing traffic to the appropriate runtime environment based on the agent/skill identifier) and preliminary security checks (synchronous authorization checks with the OMS before any processing resources are consumed — a fail-fast mechanism).
- **Agent Forge (runtime environment)**: the execution environment for Workday-delivered agents (1P). Located in the Machine Learning Private Cloud (MLPC), Agent Forge hosts the large language models (LLMs), the orchestration logic (e.g. LangGraph), and the specific "tools" (code functions) the agent uses to reason and act.
- **Workday Extend and Workday Orchestrate**: for extensibility, ASOR leverages the Workday Extend platform, including the API Gateway for external API management and Workday Orchestrate for defining complex, multistep workflows that agents can trigger.

## Agent lifecycle management

ASOR structures its capabilities around the lifecycle of a worker, applying human resource concepts to digital entities — register, configure, activate, and deactivate.

- **Register (Hiring)**: users browse the Marketplace for agents based on capabilities such as recruiting or financial audit (Discovery). Selecting an agent installs the Agent Definition into the customer's tenanted ASOR instance (Installation). This triggers creation of the ASU in the OMS (Identity creation) — establishing the agent's unique digital identity for all subsequent authentication and auditing.
- **Configure (Onboarding)**: administrators toggle specific skills on or off (e.g. a Payroll Agent might have "View pay results" enabled but "Finalize payroll" disabled during a pilot phase). Administrators assign specific Workday Security Groups to the agent's skills — the "Agent Interaction Policy" — defining who in the organization is permitted to converse with or invoke the agent. Configuration also determines where the agent can navigate and which data domains it may traverse.
- **Activate and monitor (Performance)**: real-time analytics track successful scalability, task completion rates, and error frequencies. Observability allows administrators to view detailed traces of agent reasoning ("chain of thought") to understand why an agent made a specific decision. Feedback loops help refine the agent's output and efficacy over time.
- **Deactivate (Offboarding)**: deactivation revokes the agent's active status, immediately blocking access to its skills (a "kill switch"). Credential revocation invalidates the ASU's Access Tokens and removes its security group assignments. The platform provides pathways for securely handling or purging datasets.

## Agent definitions and object models

### Agent types and classifications

| Agent Type | Description | Execution Environment | Security Context |
|---|---|---|---|
| 1P Agent (First Party) | Agents delivered by Workday (e.g., Payroll Agent, Recruiter Agent) | Workday MLPC (Agent Forge) | High trust. Uses internal API routes. Governed strictly by the internal Workday development lifecycle. |
| 3P Agent (Third Party) | Agents built by partners (e.g., Salesforce, Microsoft) registered in Workday | Partner runtime environment | External trust. Requires rigorous OAuth "dance" and explicit API configuration. Operates outside the direct control of Workday but is governed via ASOR. |
| External Agent | Agents operating in non-Workday systems without Workday API interaction | External platform | Observability only. Registered for tracking purposes; no ASU operational capabilities. Used primarily for inventory and holistic workforce visibility. |

### The core object model: Agent, Skill, and Tool

- **Agent Definition**: the top-level container — metadata such as agent name, description, provider, and version. Aligns with the Google A2A Agent Card specification on key fields (name, description, icon) but extends it with Workday-specific constructs such as security schemes and tenant context.
- **Agent Skill**: a logical grouping of capabilities that accomplishes a discrete goal (e.g. a Payroll Agent might have separate "Payroll data insights" and "Payroll processing reconciliation" skills). Security groups are attached at the skill level, not just the agent level, allowing granular access control (e.g. broad access to a "General FAQ" skill while restricting "Approve transaction" to managers only). Credit consumption and ROI metrics are also tracked at the skill level.
- **Agent Tool (ASOR Tool)**: represents the specific mechanism used to execute an action — typically a direct API use, wrapped with context (name, description) explaining why the tool is needed for the associated skill. Distinct from an Agent Forge Tool (a piece of runtime code) — the ASOR Tool is the governance object in the OMS that secures the entry point.
- **Agent Resource**: each Agent Tool links to exactly one Agent Resource — the actual securable item within Workday (a REST API endpoint, SOAP Web Service task, or Workday Query Language/WQL data source). Determines the "secured context" — which domain policies must be checked.

## Agent Gateway and routing architecture

**Flow 1 — Routing for Workday-Owned Agents**: a Workday service (e.g. Flight Deck) sends an invocation request to the Agent Gateway including the agent/skill identifier and the end-user's auth token. The Gateway resolves the Extend Tenant Alias (ensuring tenant isolation), performs a synchronous security pre-check against the tenant's OMS (validating the user's permissions against the Agent Interaction Policy before any AI compute is engaged), then routes to Agent Forge if the check passes.

**Flow 2 — Agent Forge performs ASU token exchange**: Agent Forge does not use the human user's token directly for action — it exchanges it for an "on behalf of" (OBO) token via an OAuth request to the Agent Gateway (providing the tenant alias, end-user ID token, and ASU client ID + secret). The OMS validates these and issues an OBO Access Token cryptographically binding the ASU identity with the human user identity, so subsequent actions log as "Agent X on behalf of User Y."

**Flow 3 — Agent makes API requests**: with the OBO token, Agent Forge executes standard REST API calls against the Agent Gateway, which extracts the tenant alias from the token to route to the correct OMS. The OMS enforces row-level security based on the intersection of the ASU's permissions and the human user's permissions — the core security guarantee of Delegate Mode.

**Third-Party Agent routing** follows a similar pattern but initiates from outside the Workday network via a standard OAuth 2.0 "dance": the 3P Agent requests authorization (`/authorize`), the user authenticates via the Workday login page, an authorization code is returned, and the agent exchanges it (`/token`, with client_id/client_secret) for an OBO Access Token.

## Identity, authentication, and authorization

The Agent System User (ASU) is the fundamental identity unit in ASOR. Each agent can have up to two ASUs — one for Delegate Mode and one for Ambient Mode — preventing an agent operating in the background from accidentally inheriting the permissions of a privileged user it previously assisted.

**Delegate Mode**: the agent acts as a proxy for a human user, explicitly invoked (e.g. "Request time off for me"). Authorization evaluates the intersection of: does the human user have permission to perform the action; does the ASU have permission; does the human user have permission to talk to this agent (Agent Interaction Policy). The OBO token carries both the user ID and the ASU ID, and the audit log reflects "action by Agent X on behalf of User Y."

**Ambient Mode**: the agent operates autonomously without direct human invocation (e.g. a Financial Audit Agent scanning all journal entries for anomalies overnight). The execution context is solely that of the ASU; the token's `sub` claim contains the ASU WID with no user context. Access is controlled strictly by the security groups assigned to the Ambient Agent (a specialized "Ambient Agent Security Group" is auto-created for these agents).

| Token Type | Sub Claim | Act Claim | Scopes | Use Case |
|---|---|---|---|---|
| User session | User WID | N/A | User's security groups | Initial user interaction |
| Delegate token | User WID | ASU WID | Agent's enabled skills | 1P/3P Agent acting for user |
| Ambient token | ASU WID | N/A | Agent's ambient security group | Background/autonomous task |

## Security and compliance governance

ASOR mitigates new AI-related security risks through a "defense in depth" strategy:
- **Guardrails and input protection**: input guardrails analyze incoming prompts to detect prompt injection attacks and data leakage (PII in the prompt) — blocking requests before they reach the model. Content moderation scans agent output for toxicity, bias, and hallucinations; automated reasoning engines verify factual accuracy against trusted data sources. Human-in-the-loop configuration mandates human review/approval for high-stakes actions (e.g. posting a financial transaction) so final accountability rests with a human.
- **Data security and encryption**: agent configurations, definitions, and logs stored in the OMS are encrypted using tenant-specific keys (AES-256). Communication between the Agent Gateway and the MLPC is secured via TLS 1.2+. Agent Forge runtime services use strictly tenanted contexts, preventing data bleed between customers.
- **Compliance and auditing**: every API request made by an agent includes the ASU's unique "fingerprint," distinguishing an action taken by a human from an action taken by an agent on behalf of that human. Interaction logs (who initiated it, what input was provided, what tools were invoked) are retained for a minimum period (e.g. six months) to support post-incident analysis and regulatory audits (such as the EU AI Act). ASOR is included in Workday SOC 1 Type II and SOC 2 Type II reports.

## Observability and analytics

The Agent Management Hub is a centralized dashboard for monitoring the health, performance, and value of the digital workforce:
- **Operational visibility**: usage heatmaps (peak usage times/days for capacity planning), reliability metrics (error rates, latency, throughput, identifying "drifting" agents or failing integrations), and tracing/explainability (a detailed "chain of thought" trace for every agent interaction, including reasoning steps, tools invoked, and raw tool outputs).
- **Business value and ROI analytics**: success rate (completed vs. abandoned/failed requests), engagement rate (interactions per agent), cost tracking (token/API usage → cost per interaction, for AI consumption budgeting and ROI calculation), and user satisfaction (implicit feedback plus explicit CSAT scores).

| Category | Metric | Definition | Purpose |
|---|---|---|---|
| Performance | Latency | Time taken to generate a response | User experience monitoring |
| Reliability | Error rate | Frequency of failed requests | System health and stability |
| Quality | Hallucination rate | Frequency of factually incorrect outputs | Trust and safety |
| Value | Cost per task | Infrastructure cost per completed action | ROI analysis |
| Adoption | Engagement | Total active users per agent | Workforce planning |

## Integration and interoperability

ASOR supports robust integration with third-party agent platforms such as Microsoft Copilot and Salesforce Agentforce. Through the Agent Gateway, these external agents can securely access Workday data, with the Gateway enforcing the same authentication and authorization checks (OAuth dance, ASU token) as it does for native agents — a consistent security posture across the entire blended workforce.

Workday is actively monitoring and adopting emerging interoperability standards such as the Model Context Protocol (MCP) and Agent2Agent (A2A), which standardize how agents discover capabilities and hand off tasks to one another. ASOR's metadata-driven object model is designed to be compatible with these standards, including a mapping of Google A2A Agent Cards to ASOR Agent Definitions.

## Conclusion

By centralizing identity management through the Agent System User, enforcing granular security via Delegate and Ambient modes, and providing a unified routing architecture through the Agent Gateway, ASOR solves the fragmentation and security risks inherent in the rapid adoption of agentic AI. It provides the "unified scorecard" business leaders need to measure ROI on AI investments and the control plane IT leaders need to govern their digital workforce with confidence.
