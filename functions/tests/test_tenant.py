"""
common/tenant.py::tenant_from_event() is the single load-bearing tenant-
isolation check in the whole system — every route calls it, and every
downstream data-store call is scoped by the TenantContext it returns.
Confirmed live via curl this session: an unassigned x-client-tenant switch
gets a clean 403 while an assigned one succeeds. These tests pin that
behavior so it can never regress silently.
"""

from __future__ import annotations

import pytest

from common import tenant
from common.tenant import TenantContext, TenantError, tenant_from_event


def _headers(**overrides):
    base = {
        "x-tenant-id": "yellow-bank",
        "x-user-sub": "sub-1",
        "x-user-role": "consultant",
        "x-user-email": "person@example.com",
    }
    base.update(overrides)
    return base


class TestTenantIdValidation:
    def test_missing_tenant_id_rejected(self):
        with pytest.raises(TenantError, match="tenant_id"):
            tenant_from_event({"headers": _headers(**{"x-tenant-id": ""})})

    @pytest.mark.parametrize("bad_id", ["yellow bank", "-yellow", "a", "yellow/bank"])
    def test_malformed_tenant_id_rejected(self, bad_id):
        with pytest.raises(TenantError):
            tenant_from_event({"headers": _headers(**{"x-tenant-id": bad_id})})

    def test_valid_tenant_id_accepted(self):
        ctx = tenant_from_event({"headers": _headers()})
        assert ctx.tenant_id == "yellow-bank"

    def test_tenant_id_is_lowercased_before_validation(self):
        # tenant_from_event() normalizes case before matching _TENANT_ID_PATTERN
        # (the pattern itself is lowercase-only) — an uppercase claim is
        # accepted and folded to lowercase, not rejected.
        ctx = tenant_from_event({"headers": _headers(**{"x-tenant-id": "Yellow-Bank"})})
        assert ctx.tenant_id == "yellow-bank"


class TestUserIdAndRoleValidation:
    def test_missing_sub_rejected(self):
        with pytest.raises(TenantError, match="sub"):
            tenant_from_event({"headers": _headers(**{"x-user-sub": ""})})

    def test_invalid_role_rejected(self):
        with pytest.raises(TenantError, match="role"):
            tenant_from_event({"headers": _headers(**{"x-user-role": "security_admin"})})

    @pytest.mark.parametrize("role", ["consultant", "project_admin", "super_admin"])
    def test_every_valid_role_accepted(self, role):
        ctx = tenant_from_event({"headers": _headers(**{"x-user-role": role})})
        assert ctx.role == role


class TestClientTenantSwitch:
    def test_consultant_switch_allowed_when_assigned(self, mocker):
        mocker.patch.object(tenant, "is_assigned", return_value=True)
        ctx = tenant_from_event({
            "headers": _headers(**{"x-client-tenant": "acme"}),
        })
        assert ctx.tenant_id == "acme"

    def test_consultant_switch_rejected_when_not_assigned(self, mocker):
        mocker.patch.object(tenant, "is_assigned", return_value=False)
        with pytest.raises(TenantError, match="not assigned"):
            tenant_from_event({
                "headers": _headers(**{"x-client-tenant": "acme"}),
            })

    def test_project_admin_switch_also_checks_assignment(self, mocker):
        spy = mocker.patch.object(tenant, "is_assigned", return_value=True)
        tenant_from_event({
            "headers": _headers(**{"x-user-role": "project_admin", "x-client-tenant": "acme"}),
        })
        spy.assert_called_once_with("sub-1", "acme")

    def test_super_admin_switch_bypasses_assignment_check(self, mocker):
        spy = mocker.patch.object(tenant, "is_assigned")
        ctx = tenant_from_event({
            "headers": _headers(**{"x-user-role": "super_admin", "x-client-tenant": "acme"}),
        })
        assert ctx.tenant_id == "acme"
        spy.assert_not_called()

    def test_malformed_client_tenant_header_rejected(self, mocker):
        mocker.patch.object(tenant, "is_assigned", return_value=True)
        with pytest.raises(TenantError, match="x-client-tenant"):
            tenant_from_event({
                "headers": _headers(**{"x-client-tenant": "Not Valid"}),
            })

    def test_no_switch_when_header_absent(self, mocker):
        spy = mocker.patch.object(tenant, "is_assigned")
        ctx = tenant_from_event({"headers": _headers()})
        assert ctx.tenant_id == "yellow-bank"
        spy.assert_not_called()


class TestRequireRole:
    def test_allowed_role_passes(self):
        ctx = TenantContext(tenant_id="acme", user_id="u1", role="consultant")
        ctx.require_role("consultant", "super_admin")  # should not raise

    def test_disallowed_role_raises(self):
        ctx = TenantContext(tenant_id="acme", user_id="u1", role="consultant")
        with pytest.raises(TenantError, match="not permitted"):
            ctx.require_role("super_admin")


class TestStorageKeyShapers:
    def test_s3_key_builds_tenant_scoped_path(self):
        ctx = TenantContext(tenant_id="acme", user_id="u1", role="consultant")
        assert ctx.s3_key("uploads", "file.xlsx") == "tenants/acme/uploads/file.xlsx"

    @pytest.mark.parametrize("part", ["..", "../secrets", "/etc/passwd", ""])
    def test_s3_key_rejects_unsafe_parts(self, part):
        ctx = TenantContext(tenant_id="acme", user_id="u1", role="consultant")
        with pytest.raises(TenantError):
            ctx.s3_key("uploads", part)

    def test_pg_schema_replaces_dashes_with_underscores(self):
        ctx = TenantContext(tenant_id="yellow-bank", user_id="u1", role="consultant")
        assert ctx.pg_schema() == "t_yellow_bank"
