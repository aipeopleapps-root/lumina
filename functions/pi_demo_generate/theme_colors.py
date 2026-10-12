"""
Fixed hex-blend darken/lighten for the demo template's theme CSS variables.
Deliberately not HSL/colorsys-based — plain RGB blending toward black/white is
simpler, has no hue-wrap edge cases, and degrades gracefully for very light or
very dark client primary colors (blend amounts are ratios, so results stay in
range without extra clamping logic).

Per the spec: hover/active/soft are always derived from theme.primaryColor —
never LLM-guessed, never computed inside the Jinja2 template. secondary/accent
are intentionally NOT derived from the client's color — they're the fixed
Workday-navy/orange gradient used in the promo card and agent orb, which
represents the Workday product being demoed, not the client's brand.
"""

from __future__ import annotations

_DEFAULT_PRIMARY = "#0875E1"
_SECONDARY = "#0B1F4B"
_ACCENT = "#F4990B"

# Blend ratios tuned so the default primary (#0875E1) reproduces the original
# reference template's hardcoded hover/active/soft values almost exactly.
_HOVER_BLEND = 0.15
_ACTIVE_BLEND = 0.29
_SOFT_BLEND = 0.90


def _hex_to_rgb(h: str) -> tuple[float, float, float]:
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def _rgb_to_hex(rgb: tuple[float, float, float]) -> str:
    return "#" + "".join(f"{max(0, min(255, round(c))):02X}" for c in rgb)


def _blend(hex_color: str, target: tuple[int, int, int], amount: float) -> str:
    r, g, b = _hex_to_rgb(hex_color)
    tr, tg, tb = target
    return _rgb_to_hex((r + (tr - r) * amount, g + (tg - g) * amount, b + (tb - b) * amount))


def derive_theme_colors(primary_hex: str | None = None) -> dict[str, str]:
    """
    Returns the six theme CSS variable values as hex strings:
    primary, primary_hover, primary_active, primary_soft, secondary, accent.
    """
    primary = (primary_hex or _DEFAULT_PRIMARY).strip()
    if not primary.startswith("#"):
        primary = "#" + primary
    try:
        _hex_to_rgb(primary)
    except ValueError:
        primary = _DEFAULT_PRIMARY

    return {
        "primary": primary,
        "primary_hover": _blend(primary, (0, 0, 0), _HOVER_BLEND),
        "primary_active": _blend(primary, (0, 0, 0), _ACTIVE_BLEND),
        "primary_soft": _blend(primary, (255, 255, 255), _SOFT_BLEND),
        "secondary": _SECONDARY,
        "accent": _ACCENT,
    }
