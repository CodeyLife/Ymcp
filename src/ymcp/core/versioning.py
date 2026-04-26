SCHEMA_VERSION = "3.0"

COMPATIBLE_CHANGE_POLICY = (
    "Compatible schema changes may add optional fields with safe defaults, "
    "clarify documentation, or expand enums only when unknown-safe handling is tested."
)

BREAKING_CHANGE_POLICY = (
    "Breaking schema changes include renaming/removing fields, changing requiredness, "
    "changing enum semantics, changing canonical tool names, or changing artifact structure."
)

UNKNOWN_SAFE_ENUM_EXPANSION = (
    "Enum expansion is unknown-safe only when consumers can ignore unknown values or map "
    "them to a documented fallback without changing behavior."
)

