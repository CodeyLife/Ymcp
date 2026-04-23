from __future__ import annotations


MEMORY_CONTEXT_PREFIX = "记忆检索："
MEMORY_NO_RESULT_MARKER = "未找到"
MEMORY_ERROR_MARKER = "失败："


def analyze_memory_context(items: list[str]) -> tuple[bool, int, list[str]]:
    search_items = [str(item) for item in items if str(item).startswith(MEMORY_CONTEXT_PREFIX)]
    search_performed = bool(search_items)
    retrieved_context = [
        item for item in search_items if MEMORY_NO_RESULT_MARKER not in item and MEMORY_ERROR_MARKER not in item
    ]
    return search_performed, len(retrieved_context), retrieved_context
