# Workday Agent System of Record (ASOR) — Functional Whitepaper

## Overview

As global enterprises increasingly integrate AI agents into their core operations, a fundamental shift is occurring from human-centric workflows to collaborative human-agent ecosystems. This transition necessitates a unified architectural framework capable of mitigating technical sprawl, ensuring rigorous security compliance, and providing granular visibility into digital labor.

This whitepaper provides an overview of what the Workday Agent System of Record (ASOR) does for Workday customers and the problems that ASOR solves for agentic deployments. The functional whitepaper takes a higher-level view of the architectural principles covered in depth by the Workday Agent System of Record Technical Whitepaper, which dissects the technical mechanisms of the Agent Gateway, the Object Management Server integrations, and the rigorous authentication flows that ensure data integrity and compliance across the Workday ecosystem. This whitepaper covers the core functional areas of the ASOR platform and connecting technologies.

The Workday Agent System of Record is the cornerstone for navigating the future of work, enabling seamless and effective human-AI collaboration. Unlike competitor systems that offer isolated agent management platforms that lack understanding of the human workforce, ASOR combines Workday's proven strengths in human capital management (HCM) and financial management with the power of AI agents.

This unique combination empowers organizations to transform how they govern, scale, and orchestrate their human-AI workforce — all while maximizing the value of their agentic AI strategies. The Workday Agent System of Record represents a critical evolution in enterprise architecture: it elevates AI agents from disparate, unmanageable tools to first-class members of the workforce, governed by the same rigorous standards as human employees.

## Platform

ASOR unifies the management of all AI agents by establishing a structured agent lifecycle — mirroring the employee lifecycle Workday delivers today. This system provides a unified point of agent management, and therefore critical visibility and context into every human-AI interaction — across Workday agents, partner agents, and third-party agents.

ASOR is a SaaS-based, tenanted admin console that is deployed inside a Workday customer's environment. The Agent Management Hub is the central landing page for ASOR activities. Any customer that has deployed the Workday core suite (Workday HCM and/or Workday Financial Management) has access to ASOR. It does not require a SKU, nor does it carry a cost on its own. Agent consumption is centered on Flex Credits, be it through agent skill usage or API access — those are independent of ASOR.

ASOR works with the Workday Marketplace and the Agent Gateway to provide agentic AI management into a Workday deployment and across a customer's full enterprise.

The Agent Registry shows the admin what Workday-delivered agents are currently available to be configured and activated. Should an agent require additional SKUs (for example, the Planning Agent requires the Workday Planning SKU), the Agent Registry will show the requirements for activation. The admin is able to bring other agents into the Agent Registry via the Agent Marketplace or by manually registering external agents via APIs.

The Workday Marketplace is a tool to allow admins to discover new agents for their ASOR tenant. Agents on the Marketplace are developed by a trusted partner developer. Partner agents exist outside the Workday platform but actively work with Workday data, either in part or in full. Customers can also leverage Workday agent development tools to create custom agents that run inside the Workday platform (via Flowise, Workday Extend, and Workday Sana). External agents — agents that are built outside Workday — can be registered and monitored in ASOR.

### Types of agents

- **1P Agents (First Party)**: These agents are developed and published by Workday. They operate on Workday data and execute inside the Workday platform. They are highly trusted by the platform, as they use internal APIs, and have the most access across the Workday platform.
- **3P Agents (Third Party)**: These agents are developed by trusted partners that run outside Workday but operate with Workday data. They are discovered and registered via the Agent Marketplace. These can also be agents that are built by customers on the Workday platform.
- **External Agents**: These are agents built outside the Workday platform. They could be built in many different ways and deployed anywhere. They can still be registered inside ASOR. Any Third-Party Agent that actually interacts with Workday data will do so via the Agent Gateway.

### Agent execution modes

- **Ambient agent**: An agent that can be invoked by events, timers, triggers, or notifications in the system, and acts independently from human interaction. Ambient agents are capable of being started on a schedule and running a skill with another event being pushed or notification being sent. The agent's guardrails (data security settings) are defined inside ASOR.
- **Delegate agent**: An agent that has skills that are invoked by a human, either through direct connection and request, or through a conversation and an orchestrator picking an appropriate skill that the user has access to. Delegate agents can hand off to other agents to complete their work, and do not need to send push notifications out when complete. The agent will assume the security posture of the user who invokes the agent session.

## Agent lifecycle

Like other workers, agents require a continuous cycle of management and insights across the lifecycle. ASOR facilitates every aspect of this journey.

- **Register.** In the Workday Marketplace, customers and users discover, evaluate, and request agents based on their capabilities and skills. They install agents to appear in their company's tenanted ASOR.
- **Configure.** Enterprises onboard and configure agents for their employees, evaluating the skills they want to turn on or off, establishing appropriate protocols for security credentialing, and directing where agents can navigate to and who they interact with (via Workday Security Groups).
- **Activate.** ASOR analyzes performance, refines output with user feedback, and provides explainability in order to measure efficacy and impact. Users evaluate agent performance — intelligently monitoring for successful scalability, task completion rate, and observability.
- **Deactivate.** Whether at the end of value or for agents behaving in unexpected ways, ASOR provides pathways to deactivating agents and securely handling or sunsetting agent datasets.

## Governance

ASOR allows all agent approval and visibility to be centralized. This means that one admin or team is responsible for approving which agents are allowed to be deployed across the enterprise, helping to reduce shadow IT for agents. Any agent that is later found to be inadequate or insecure can easily be deactivated or removed from the enterprise. This centralization mitigates security risks, cost overruns, or duplicated tech deployments due to a lack of visibility.

When it comes to agent deployment — the actual configuration and activation of agents — individual business leaders across the enterprise can take on the efforts. This means that once an agent is vetted and approved, the decisions on when and how to deploy the agents can be handed off to those workers who best understand the context of the given instance that an agent will be operating in.

## Identity

The key aspect of ASOR identity management is the fact that agents are treated as users just like human workers. They are given access and privileges in the same manner via the Agent System User (ASU). When the agent is registered, an ASU is created — one for Ambient Mode and one for Delegate Mode. The agent owner defines their access via security policies in the same way they would assign access to a human worker, with the same limitations of access and privileges.

When an agent executes, it does so either via ambient execution or delegate execution. In Ambient Mode, the ASU uses its predefined access, which was defined when the agent was configured. When it executes in Delegate Mode, the agent will be given either the access of its original configuration or the access of the invoking user — whichever resolves with the least privilege. This prevents users from invoking agents to access data or tools they would not otherwise have access to.

To add an additional layer of security, an agent with multiple skills will have the security policy applied to each skill, preventing different skills from being misused or accessing data they should not be able to access.

As it is very common for customers to leverage public Workday APIs to expand external agent capabilities, these API calls are also supported through ASOR via the Agent Gateway. Outside ASOR, Workday APIs are invoked using an Integration System User (ISU), but when ASOR is leveraged to process the API calls, those calls are now shifted from an ISU to an ASU — allowing the invoked API to be tied to a given user based on who used the external agent in a way that triggered an API call, and providing more detailed visibility and auditability over legacy ISU-based calls.

## Configuration of skills

Agent Definitions are the metadata that describes an agent. This is defined by the agent developer before the agent is published in the Agent Marketplace. It includes general details such as name, resource location (URL), version, description, capabilities, skills, and tools.

**Tools** are individual resources that are used by an agent to complete some task — the simplest form of execution. Tools could be a database, a large language model, or anything that supports an agent's processing. Tools are grouped together to create a skill.

**Skills** are the general functionality for an agent. Each agent can have many skills, all of which can be toggled on or off by the agent owner, and each skill has its own security policy. When you combine a batch of skills together, you get a capability.

**Capabilities** are non-configurable descriptions of an agent's overall skillset. As tools are batched together to create a skill, skills are batched together to create a capability.

**Guardrails** are a security configuration that defines who can access a given agent. This is done via Workday Security Groups and ensures that an agent is limited to only be invoked by the users that have the proper authority to perform the tasks and processes the agent is able to complete.

Example configuration: Agent Definition "Workday Self-Service Agent" → Skills "Core Policy", "Manage My Time and Absence" → Tools "Time Off Details API", "Worker View API", "Eligible Absence Types API".

## Observability and metrics

One of the key capabilities of ASOR is the ability of administrators to view and analyze agent activities and output, giving insight into an agent's value across the enterprise. While Workday-delivered agents, partner-delivered agents, and agents the customer has created inside the Workday ecosystem will have the most robust set of data for observability, Workday has created an Observability Interface into the Agent Gateway to ensure all external agents can send complete observability logs into ASOR.

How metrics are analyzed is unique across different agents, but in general they are displayed with respect to the different skills they execute. A Workday deployment has a clear understanding of a customer's business processes and historical data associated with how long it takes a human worker to complete them. When an agent is then brought in to assist a human in a given business process, the time to completion can be shown in comparison to how long it previously took, on average, for the human workers to complete those processes — leading to a clear, in-context picture of the value a given agent is providing the human workforce.

## Interoperability (via A2A and MCP)

ASOR leverages both Model Context Protocol (MCP) and Google's Agent2Agent (A2A) protocol. A2A is used for Agent Cards and to facilitate Agent-to-Agent discovery and communication. MCP is used to publish tools available for agents to leverage via the Agent Gateway.

As more agents are created and deployed, a key problem that arises is that different agent tools likely have unique APIs to interact with or integrate with — meaning developers must learn and maintain a growing scope of APIs. A2A and MCP ease the workload of integrating with or interacting with agents or agent tools: developers only need to understand two protocols rather than maintaining new APIs for every new agent and tool. ASOR leverages these protocols both to allow custom agents access to Workday data and to allow agents inside the Workday platform to reach outside for external tasks or processing.

## Workday Marketplace

The Workday Marketplace is a source of ready-built agents with unique functionality achieving specialized use cases for Workday customers. Admins can easily discover agents in the Marketplace and activate them directly into their ASOR tenant. Partners are able to publish approved agents directly into the Agent Marketplace. Agents can also be activated from the Marketplace into non-production tenants, allowing admins and agent owners a safe path to testing and evaluating different agents before pushing them into production.

## Agent Partner Network

Workday is actively expanding many different forms of partnerships with external vendors in different areas of integration. This includes identity providers such as Microsoft Entra ID and Okta that allow user identities to extend across systems to ensure seamless and secure access to data, agents, and resources — even when agents cross between Workday data and external systems. ASOR also integrates with other agent platforms such as Microsoft Copilot, Google Enterprise, and Amazon Bedrock, permitting agents built on these platforms to both access Workday agents, agentic tools, and data, and create seamless onboarding into ASOR with expanded visibility and logging of agent activities.
