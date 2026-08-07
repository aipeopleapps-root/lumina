"""
Get the folder structure for the calling user's tenant.
Reads the tenant's template choice from Aurora, then returns
the matching template from the bundled config file.
"""
import json
import logging
import os

from common import tenant_from_event, TenantError, http, db

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

_TEMPLATES_PATH = os.path.join(os.path.dirname(__file__), "config", "folder-templates.json")

with open(_TEMPLATES_PATH) as _f:
    _TEMPLATES = json.load(_f)["templates"]


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        with db.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT folder_structure_template FROM admin.tenants WHERE tenant_id = %s",
                    (ctx.tenant_id,)
                )
                row = cur.fetchone()

        template_id = (row[0] if row and row[0] else "standard_workday")
        template = _TEMPLATES.get(template_id) or _TEMPLATES["standard_workday"]

        return http.ok({
            "tenant_id": ctx.tenant_id,
            "template_id": template_id,
            "template": template,
        })

    except Exception as e:
        log.error("Failed to get folder structure: %s", e, exc_info=True)
        return http.error("Failed to get folder structure")
