"""
Admin: Get available folder structure templates
"""
import json
import logging
import os

from common import tenant_from_event, TenantError, http

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_TEMPLATES_PATH = os.path.join(os.path.dirname(__file__), "config", "folder-templates.json")


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        with open(_TEMPLATES_PATH) as f:
            data = json.load(f)
        return http.ok({"templates": list(data["templates"].values())})
    except Exception as e:
        log.error("Failed to load templates: %s", e, exc_info=True)
        return http.error("Failed to load folder templates")
