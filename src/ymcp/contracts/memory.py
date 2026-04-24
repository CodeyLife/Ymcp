from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, create_model

from ymcp.contracts.common import ToolResultBase, WorkflowRequestBase


class MemoryArtifacts(BaseModel):
    operation: str
    count: int = 0
    items: list[dict[str, Any]] = Field(default_factory=list)
    message: str | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


class MemoryResult(ToolResultBase[MemoryArtifacts]):
    artifacts: MemoryArtifacts


MEMPALACE_TOOL_SCHEMAS: tuple[dict[str, Any], ...] = (
    {"name": "mempalace_status", "description": "Palace overview — total drawers, wing and room counts", "properties": {}, "required": []},
    {"name": "mempalace_list_wings", "description": "List all wings with drawer counts", "properties": {}, "required": []},
    {
        "name": "mempalace_list_rooms",
        "description": "List rooms within a wing (or all rooms if no wing given)",
        "properties": {
            "wing": {"type": "string", "description": "Wing to list rooms for (optional)"},
            "project_id": {"type": "string", "description": "Stable host-provided project ID used to derive a default wing when wing is omitted"},
            "project_root": {"type": "string", "description": "Host workspace/project root path used to derive a default wing when project_id and wing are omitted"},
        },
        "required": [],
    },
    {"name": "mempalace_get_taxonomy", "description": "Full taxonomy: wing → room → drawer count", "properties": {}, "required": []},
    {
        "name": "mempalace_get_aaak_spec",
        "description": "Get the AAAK dialect specification — the compressed memory format MemPalace uses. Call this if you need to read or write AAAK-compressed memories.",
        "properties": {},
        "required": [],
    },
    {
        "name": "mempalace_kg_query",
        "description": "Query the knowledge graph for an entity's relationships. Returns typed facts with temporal validity. E.g. 'Max' → child_of Alice, loves chess, does swimming. Filter by date with as_of to see what was true at a point in time.",
        "properties": {
            "entity": {"type": "string", "description": "Entity to query (e.g. 'Max', 'MyProject', 'Alice')"},
            "as_of": {"type": "string", "description": "Date filter — only facts valid at this date (YYYY-MM-DD, optional)"},
            "direction": {"type": "string", "description": "outgoing (entity→?), incoming (?→entity), or both (default: both)"},
        },
        "required": ["entity"],
    },
    {
        "name": "mempalace_kg_add",
        "description": "Add a fact to the knowledge graph. Subject → predicate → object with optional time window. E.g. ('Max', 'started_school', 'Year 7', valid_from='2026-09-01').",
        "properties": {
            "subject": {"type": "string", "description": "The entity doing/being something"},
            "predicate": {"type": "string", "description": "The relationship type (e.g. 'loves', 'works_on', 'daughter_of')"},
            "object": {"type": "string", "description": "The entity being connected to"},
            "valid_from": {"type": "string", "description": "When this became true (YYYY-MM-DD, optional)"},
            "source_closet": {"type": "string", "description": "Closet ID where this fact appears (optional)"},
        },
        "required": ["subject", "predicate", "object"],
    },
    {
        "name": "mempalace_kg_invalidate",
        "description": "Mark a fact as no longer true. E.g. ankle injury resolved, job ended, moved house.",
        "properties": {
            "subject": {"type": "string", "description": "Entity"},
            "predicate": {"type": "string", "description": "Relationship"},
            "object": {"type": "string", "description": "Connected entity"},
            "ended": {"type": "string", "description": "When it stopped being true (YYYY-MM-DD, default: today)"},
        },
        "required": ["subject", "predicate", "object"],
    },
    {
        "name": "mempalace_kg_timeline",
        "description": "Chronological timeline of facts. Shows the story of an entity (or everything) in order.",
        "properties": {"entity": {"type": "string", "description": "Entity to get timeline for (optional — omit for full timeline)"}},
        "required": [],
    },
    {"name": "mempalace_kg_stats", "description": "Knowledge graph overview: entities, triples, current vs expired facts, relationship types.", "properties": {}, "required": []},
    {
        "name": "mempalace_traverse",
        "description": "Walk the palace graph from a room. Shows connected ideas across wings — the tunnels. Like following a thread through the palace: start at 'chromadb-setup' in wing_code, discover it connects to wing_myproject (planning) and wing_user (feelings about it).",
        "properties": {
            "start_room": {"type": "string", "description": "Room to start from (e.g. 'chromadb-setup', 'riley-school')"},
            "max_hops": {"type": "integer", "description": "How many connections to follow (default: 2)"},
        },
        "required": ["start_room"],
    },
    {
        "name": "mempalace_find_tunnels",
        "description": "Find rooms that bridge two wings — the hallways connecting different domains. E.g. what topics connect wing_code to wing_team?",
        "properties": {
            "wing_a": {"type": "string", "description": "First wing (optional)"},
            "wing_b": {"type": "string", "description": "Second wing (optional)"},
        },
        "required": [],
    },
    {"name": "mempalace_graph_stats", "description": "Palace graph overview: total rooms, tunnel connections, edges between wings.", "properties": {}, "required": []},
    {
        "name": "mempalace_create_tunnel",
        "description": "Create a cross-wing tunnel linking two palace locations. Use when content in one project relates to another — e.g., an API design in project_api connects to a database schema in project_database.",
        "properties": {
            "source_wing": {"type": "string", "description": "Wing of the source"},
            "source_room": {"type": "string", "description": "Room in the source wing"},
            "target_wing": {"type": "string", "description": "Wing of the target"},
            "target_room": {"type": "string", "description": "Room in the target wing"},
            "label": {"type": "string", "description": "Description of the connection"},
            "source_drawer_id": {"type": "string", "description": "Optional specific drawer ID"},
            "target_drawer_id": {"type": "string", "description": "Optional specific drawer ID"},
        },
        "required": ["source_wing", "source_room", "target_wing", "target_room"],
    },
    {
        "name": "mempalace_list_tunnels",
        "description": "List all explicit cross-wing tunnels. Optionally filter by wing.",
        "properties": {"wing": {"type": "string", "description": "Filter tunnels by wing (shows tunnels where wing is source or target)"}},
        "required": [],
    },
    {
        "name": "mempalace_delete_tunnel",
        "description": "Delete an explicit tunnel by its ID.",
        "properties": {"tunnel_id": {"type": "string", "description": "Tunnel ID to delete"}},
        "required": ["tunnel_id"],
    },
    {
        "name": "mempalace_follow_tunnels",
        "description": "Follow tunnels from a room to see what it connects to in other wings. Returns connected rooms with drawer previews.",
        "properties": {
            "wing": {"type": "string", "description": "Wing to start from"},
            "room": {"type": "string", "description": "Room to follow tunnels from"},
        },
        "required": ["wing", "room"],
    },
    {
        "name": "mempalace_search",
        "description": "Semantic search. Returns verbatim drawer content with similarity scores. IMPORTANT: 'query' must contain ONLY search keywords. Use 'context' for background. Results with cosine distance > max_distance are filtered out.",
        "properties": {
            "query": {"type": "string", "description": "Short search query ONLY — keywords or a question. Max 250 chars.", "maxLength": 250},
            "limit": {"type": "integer", "description": "Max results (default 5)", "minimum": 1, "maximum": 100},
            "wing": {"type": "string", "description": "Filter by wing (optional)"},
            "room": {"type": "string", "description": "Filter by room (optional)"},
            "max_distance": {"type": "number", "description": "Max cosine distance threshold (0=identical, 2=opposite). Results further than this are dropped. Lower = stricter. Default 1.5. Set to 0 to disable."},
            "context": {"type": "string", "description": "Background context for the search (optional). NOT used for embedding — only for future re-ranking."},
            "project_id": {"type": "string", "description": "Stable host-provided project ID used to derive a default wing filter when wing is omitted"},
            "project_root": {"type": "string", "description": "Host workspace/project root path used to derive a default wing filter when project_id and wing are omitted"},
        },
        "required": ["query"],
    },
    {
        "name": "mempalace_check_duplicate",
        "description": "Check if content already exists in the palace before filing",
        "properties": {
            "content": {"type": "string", "description": "Content to check"},
            "threshold": {"type": "number", "description": "Similarity threshold 0-1 (default 0.9)"},
        },
        "required": ["content"],
    },
    {
        "name": "mempalace_add_drawer",
        "description": "File verbatim content into the palace. Checks for duplicates first. If wing is omitted, Ymcp derives it from host project context before falling back to personal.",
        "properties": {
            "wing": {"type": "string", "description": "Wing (project name). Optional when host supplies project_id/project_root."},
            "room": {"type": "string", "description": "Room (aspect: backend, decisions, meetings...)"},
            "content": {"type": "string", "description": "Verbatim content to store — exact words, never summarized"},
            "source_file": {"type": "string", "description": "Where this came from (optional)"},
            "added_by": {"type": "string", "description": "Who is filing this (default: mcp)"},
            "project_id": {"type": "string", "description": "Stable host-provided project ID used to derive the wing when wing is omitted"},
            "project_root": {"type": "string", "description": "Host workspace/project root path used to derive the wing when project_id and wing are omitted"},
        },
        "required": ["room", "content"],
    },
    {
        "name": "mempalace_delete_drawer",
        "description": "Delete a drawer by ID. Irreversible.",
        "properties": {"drawer_id": {"type": "string", "description": "ID of the drawer to delete"}},
        "required": ["drawer_id"],
    },
    {
        "name": "mempalace_get_drawer",
        "description": "Fetch a single drawer by ID — returns full content and metadata.",
        "properties": {"drawer_id": {"type": "string", "description": "ID of the drawer to fetch"}},
        "required": ["drawer_id"],
    },
    {
        "name": "mempalace_list_drawers",
        "description": "List drawers with pagination. Optional wing/room filter. Returns IDs, wings, rooms, and content previews.",
        "properties": {
            "wing": {"type": "string", "description": "Filter by wing (optional)"},
            "room": {"type": "string", "description": "Filter by room (optional)"},
            "limit": {"type": "integer", "description": "Max results per page (default 20, max 100)", "minimum": 1, "maximum": 100},
            "offset": {"type": "integer", "description": "Offset for pagination (default 0)", "minimum": 0},
            "project_id": {"type": "string", "description": "Stable host-provided project ID used to derive a default wing filter when wing is omitted"},
            "project_root": {"type": "string", "description": "Host workspace/project root path used to derive a default wing filter when project_id and wing are omitted"},
        },
        "required": [],
    },
    {
        "name": "mempalace_update_drawer",
        "description": "Update an existing drawer's content and/or metadata (wing, room). Fetches existing drawer first; returns error if not found.",
        "properties": {
            "drawer_id": {"type": "string", "description": "ID of the drawer to update"},
            "content": {"type": "string", "description": "New content (optional — omit to keep existing)"},
            "wing": {"type": "string", "description": "New wing (optional — omit to keep existing)"},
            "room": {"type": "string", "description": "New room (optional — omit to keep existing)"},
        },
        "required": ["drawer_id"],
    },
    {
        "name": "mempalace_diary_write",
        "description": "Write to your personal agent diary in AAAK format. Your observations, thoughts, what you worked on, what matters. Each agent has their own diary with full history. Write in AAAK for compression — e.g. 'SESSION:2026-04-04|built.palace.graph+diary.tools|ALC.req:agent.diaries.in.aaak|★★★'. Use entity codes from the AAAK spec.",
        "properties": {
            "agent_name": {"type": "string", "description": "Your name — each agent gets their own diary wing"},
            "entry": {"type": "string", "description": "Your diary entry in AAAK format — compressed, entity-coded, emotion-marked"},
            "topic": {"type": "string", "description": "Topic tag (optional, default: general)"},
        },
        "required": ["agent_name", "entry"],
    },
    {
        "name": "mempalace_diary_read",
        "description": "Read your recent diary entries (in AAAK). See what past versions of yourself recorded — your journal across sessions.",
        "properties": {
            "agent_name": {"type": "string", "description": "Your name — each agent gets their own diary wing"},
            "last_n": {"type": "integer", "description": "Number of recent entries to read (default: 10)"},
        },
        "required": ["agent_name"],
    },
    {
        "name": "mempalace_hook_settings",
        "description": "Get or set hook behavior. silent_save: True = save directly (no MCP clutter), False = legacy blocking. desktop_toast: True = show desktop notification. Call with no args to view.",
        "properties": {
            "silent_save": {"type": "boolean", "description": "True = silent direct save, False = blocking MCP calls"},
            "desktop_toast": {"type": "boolean", "description": "True = show desktop toast via notify-send"},
        },
        "required": [],
    },
    {"name": "mempalace_memories_filed_away", "description": "Check if a recent palace checkpoint was saved. Returns message count and timestamp.", "properties": {}, "required": []},
    {"name": "mempalace_reconnect", "description": "Force reconnect to the palace database. Use after external scripts or CLI commands modified the palace directly, which can leave the in-memory HNSW index stale.", "properties": {}, "required": []},
)


def _python_type(schema: dict[str, Any]) -> type[Any]:
    schema_type = schema.get("type")
    return {
        "string": str,
        "integer": int,
        "number": float,
        "boolean": bool,
    }.get(schema_type, Any)


def _field_info(schema: dict[str, Any], *, required: bool) -> Field:
    kwargs: dict[str, Any] = {}
    if "description" in schema:
        kwargs["description"] = schema["description"]
    if "minimum" in schema:
        kwargs["ge"] = schema["minimum"]
    if "maximum" in schema:
        kwargs["le"] = schema["maximum"]
    if "maxLength" in schema:
        kwargs["max_length"] = schema["maxLength"]
    if required:
        return Field(..., **kwargs)
    return Field(default=None, **kwargs)


def _request_model_name(tool_name: str) -> str:
    parts = [part.capitalize() for part in tool_name.split("_")]
    return "".join(parts) + "Request"


def _build_request_model(tool_schema: dict[str, Any]) -> type[WorkflowRequestBase]:
    required = set(tool_schema.get("required", []))
    model_fields: dict[str, tuple[Any, Any]] = {}
    for field_name, schema in tool_schema.get("properties", {}).items():
        py_type = _python_type(schema)
        if field_name in required:
            model_fields[field_name] = (py_type, _field_info(schema, required=True))
        else:
            model_fields[field_name] = (py_type | None, _field_info(schema, required=False))
    return create_model(_request_model_name(tool_schema["name"]), __base__=WorkflowRequestBase, **model_fields)


MEMPALACE_REQUEST_MODELS: dict[str, type[WorkflowRequestBase]] = {
    tool_schema["name"]: _build_request_model(tool_schema) for tool_schema in MEMPALACE_TOOL_SCHEMAS
}
