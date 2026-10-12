from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # LLM gateway
    LLM_GATEWAY_URL: str
    LLM_GATEWAY_API_KEY: str
    LLM_MODEL: str = "gpt-4o"
    LLM_MAX_TOKENS: int = 4096
    LLM_TIMEOUT_SECONDS: int = 60

    # Azure Blob Storage
    AZURE_STORAGE_ACCOUNT_URL: str = ""
    AZURE_STORAGE_INPUT_CONTAINER: str = "input-files"
    AZURE_STORAGE_OUTPUT_CONTAINER: str = "output-files"
    USE_MANAGED_IDENTITY: bool = True
    AZURE_STORAGE_CONNECTION_STRING: str | None = None

    # Azure Cosmos DB
    USE_COSMOS: bool = False
    COSMOS_ENDPOINT: str = ""
    COSMOS_KEY: str = ""                          # leave blank when using Managed Identity
    COSMOS_DATABASE_NAME: str = "req-to-test"
    COSMOS_CONTAINER_NAME: str = "pipeline-runs"
    COSMOS_USE_MANAGED_IDENTITY: bool = False     # set True on Deloitte infra

    # Project identity — one value per Container App deployment
    PROJECT_ID: str = "default-project"

    # Microsoft Entra External ID
    AZURE_AD_TENANT_NAME: str = ""
    AZURE_AD_TENANT_ID: str = ""
    AZURE_AD_CLIENT_ID: str = ""
    AZURE_AD_USER_FLOW: str = "signupsignin"

    # App
    APP_ENV: str = "local"


def get_settings() -> Settings:
    return Settings()
