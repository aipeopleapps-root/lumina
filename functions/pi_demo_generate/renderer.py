"""
Deterministic HTML rendering for the Process Intelligence unified agent demo.
The LLM (see prompt_demo_content.md) only ever produces structured JSON
(agent.demo_profile) — every span of HTML in the output, including per-card
markup, is produced here or in templates/macros.html.j2, never by the model.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape

from .theme_colors import derive_theme_colors

_TEMPLATES_DIR = Path(__file__).parent / "templates"

_env = Environment(
    loader=FileSystemLoader(_TEMPLATES_DIR),
    autoescape=select_autoescape(["html", "j2"]),
    trim_blocks=True,
    lstrip_blocks=True,
)

_CARD_MACROS = {
    "match_card": "match_card",
    "approval_list": "approval_list",
    "checklist": "checklist",
    "stat_row": "stat_row",
    "roi_card": "roi_card",
}


def _render_card(card: dict) -> str | None:
    macro_name = _CARD_MACROS.get((card or {}).get("type"))
    if not macro_name:
        return None
    macros_tpl = _env.get_template("macros.html.j2")
    macro = getattr(macros_tpl.module, macro_name)
    return str(macro(card))


def _prep_chat_script(transcript: list[dict]) -> list[dict]:
    """Turn the LLM's structured transcript into the JS-facing turn shape,
    pre-rendering any `cards` into `cards_html` strings via the macros."""
    prepped: list[dict] = []
    for turn in transcript or []:
        t = (turn or {}).get("type")
        if t == "divider":
            prepped.append({"type": "divider", "label": turn.get("label", "")})
        elif t == "agent_message":
            cards_html = [
                html for html in (_render_card(c) for c in (turn.get("cards") or [])) if html
            ]
            prepped.append({"type": "agent_message", "text": turn.get("text", ""), "cards_html": cards_html})
        elif t == "user_message":
            prepped.append({"type": "user_message", "text": turn.get("text", "")})
        elif t == "chip_row":
            prepped.append({"type": "chip_row", "chips": turn.get("chips") or []})
    return prepped


def _prep_mini_chat(turns: list[dict]) -> list[dict]:
    prepped: list[dict] = []
    for turn in turns or []:
        t = (turn or {}).get("type")
        if t in ("agent_message", "user_message"):
            prepped.append({"type": t, "text": turn.get("text", "")})
    return prepped


def render_demo(*, agents: list[dict], theme: dict) -> str:
    """
    agents: pi_aurora.get_agent()-shaped dicts, each with a populated
    `demo_profile` (persona/currentState/agenticWorkflow/humanRoles/maturity/
    actionsPerformed/agenticAbilities/knowledgeRequired/democontent), in the
    order they should appear in the sidebar/home directory.
    theme: {clientName, clientLogoText, clientLogoColor, primaryColor} — all
    defaults already resolved by the caller (trigger_handler), not here.
    """
    colors = derive_theme_colors(theme.get("primaryColor"))

    chat_scripts: dict[str, list[dict]] = {}
    chat_meta: dict[str, dict] = {}
    mini_chats: dict[str, list[dict]] = {}
    suggestions: dict[str, str] = {}
    chat_ids: list[str] = []
    workspace_ids: list[str] = []

    for agent in agents:
        agent_id = agent["agent_id"]
        profile = agent.get("demo_profile") or {}
        persona = profile.get("persona") or {}
        democontent = profile.get("democontent") or {}
        suggestions[agent_id] = f"Live updates and follow-ups from {agent['name']} appear here."

        if agent.get("kind") == "workspace":
            workspace_ids.append(agent_id)
            mini_chats[agent_id] = _prep_mini_chat(democontent.get("mini_chat") or [])
        else:
            chat_ids.append(agent_id)
            chat_scripts[agent_id] = _prep_chat_script(democontent.get("transcript") or [])
            chat_meta[agent_id] = {
                "initials": persona.get("initials") or "U",
                "name": persona.get("name") or "",
                "role": persona.get("role") or "",
                "title": agent["name"],
            }

    conv_count = len(chat_ids)
    ws_count = len(workspace_ids)

    template = _env.get_template("shell.html.j2")
    return template.render(
        agents=agents,
        theme=theme,
        colors=colors,
        conv_count=conv_count,
        ws_count=ws_count,
        chat_scripts=chat_scripts,
        chat_meta=chat_meta,
        mini_chats=mini_chats,
        suggestions=suggestions,
        chat_ids=chat_ids,
        workspace_ids=workspace_ids,
    )
