from enum import Enum


class DomainErrorCode(str, Enum):
    UNSUPPORTED_SCHEMA_VERSION = "unsupported_schema_version"
    NEEDS_MORE_CONTEXT = "needs_more_context"
    INCOMPLETE_EVIDENCE = "incomplete_evidence"
    BLOCKED_BY_HOST_ACTION = "blocked_by_host_action"
