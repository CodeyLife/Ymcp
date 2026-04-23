from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Type

from pydantic import BaseModel

from ymcp.contracts.deep_interview import DeepInterviewRequest, DeepInterviewResult
from ymcp.contracts.plan import PlanRequest, PlanResult
from ymcp.contracts.ralplan import RalplanRequest, RalplanResult
from ymcp.contracts.ralph import RalphRequest, RalphResult
from ymcp.contracts.memory import (
    MemoryDiaryReadRequest,
    MemoryDiaryWriteRequest,
    MemoryDrawerIdRequest,
    MemoryDuplicateRequest,
    MemoryGraphQueryRequest,
    MemoryGraphTraverseRequest,
    MemoryKgAddRequest,
    MemoryKgInvalidateRequest,
    MemoryListRoomsRequest,
    MemoryNoArgsRequest,
    MemoryResult,
    MemorySearchRequest,
    MemoryStoreRequest,
    MemoryTunnelCreateRequest,
    MemoryTunnelDeleteRequest,
    MemoryTunnelFindRequest,
    MemoryTunnelFollowRequest,
    MemoryUpdateRequest,
)
from ymcp.engine.deep_interview import build_deep_interview
from ymcp.engine.plan import build_plan
from ymcp.engine.ralplan import build_ralplan
from ymcp.engine.ralph import build_ralph
from ymcp.memory import call_mempalace_tool, limit_memory_result_items


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    request_model: Type[BaseModel]
    response_model: Type[BaseModel]
    handler: Callable[[BaseModel], BaseModel]


TOOL_SPECS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="plan",
        description="根据模式给出需求摘要、计划步骤、风险、验证方式以及宿主下一步动作。",
        request_model=PlanRequest,
        response_model=PlanResult,
        handler=build_plan,
    ),
    ToolSpec(
        name="ralplan",
        description="构建共识规划，以多角色讨论的方式达成计划共识",
        request_model=RalplanRequest,
        response_model=RalplanResult,
        handler=build_ralplan,
    ),
    ToolSpec(
        name="deep_interview",
        description="需求不明确事，进行多轮对话明确需求边界，获取更多需求信息。",
        request_model=DeepInterviewRequest,
        response_model=DeepInterviewResult,
        handler=build_deep_interview,
    ),
    ToolSpec(
        name="ralph",
        description="根据计划和用户反馈，给出宿主下一步、验证清单、是否继续以及证据缺口，不执行命令或循环。",
        request_model=RalphRequest,
        response_model=RalphResult,
        handler=build_ralph,
    ),

    ToolSpec(
        name="memory_store",
        description="将内容写入 MemPalace 长期记忆，默认 wing=personal、room=ymcp。",
        request_model=MemoryStoreRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_store", "store", "tool_add_drawer", wing=request.wing, room=request.room, content=request.content, source_file=request.source_file, added_by=request.added_by),
    ),
    ToolSpec(
        name="memory_search",
        description="从 MemPalace 中搜索长期记忆，默认搜索 personal wing。",
        request_model=MemorySearchRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_search", "search", "tool_search", query=request.query, limit=request.limit, wing=request.wing, room=request.room, max_distance=request.max_distance, min_similarity=request.min_similarity, context=request.context),
    ),
    ToolSpec(
        name="memory_get",
        description="根据 drawer_id 读取完整 MemPalace 记忆。",
        request_model=MemoryDrawerIdRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_get", "get", "tool_get_drawer", drawer_id=request.drawer_id),
    ),
    ToolSpec(
        name="memory_update",
        description="更新 MemPalace 记忆内容或分类。",
        request_model=MemoryUpdateRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_update", "update", "tool_update_drawer", drawer_id=request.drawer_id, content=request.content, wing=request.wing, room=request.room),
    ),
    ToolSpec(
        name="memory_delete",
        description="删除指定 drawer_id 的 MemPalace 记忆。",
        request_model=MemoryDrawerIdRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_delete", "delete", "tool_delete_drawer", drawer_id=request.drawer_id),
    ),
    ToolSpec(
        name="memory_status",
        description="查看 MemPalace 状态、总记忆数和 wing/room 分布。",
        request_model=MemoryNoArgsRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_status", "status", "tool_status"),
    ),
    ToolSpec(
        name="memory_list_wings",
        description="列出 MemPalace 中的所有 wing。",
        request_model=MemoryNoArgsRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_list_wings", "list_wings", "tool_list_wings"),
    ),
    ToolSpec(
        name="memory_list_rooms",
        description="列出 MemPalace room，可按 wing 过滤。",
        request_model=MemoryListRoomsRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_list_rooms", "list_rooms", "tool_list_rooms", wing=request.wing, room=None),
    ),
    ToolSpec(
        name="memory_taxonomy",
        description="查看 MemPalace taxonomy 树。",
        request_model=MemoryNoArgsRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_taxonomy", "taxonomy", "tool_get_taxonomy"),
    ),
    ToolSpec(
        name="memory_check_duplicate",
        description="写入前检查内容是否已存在于 MemPalace。",
        request_model=MemoryDuplicateRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_check_duplicate", "check_duplicate", "tool_check_duplicate", content=request.content, wing=request.wing, room=request.room),
    ),
    ToolSpec(
        name="memory_reconnect",
        description="刷新 MemPalace 连接和缓存。",
        request_model=MemoryNoArgsRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_reconnect", "reconnect", "tool_reconnect"),
    ),
    ToolSpec(
        name="memory_graph_stats",
        description="查看 MemPalace 图谱统计信息。",
        request_model=MemoryNoArgsRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_graph_stats", "graph_stats", "tool_graph_stats"),
    ),
    ToolSpec(
        name="memory_graph_query",
        description="查询 MemPalace 知识图谱实体关系。",
        request_model=MemoryGraphQueryRequest,
        response_model=MemoryResult,
        handler=lambda request: limit_memory_result_items(call_mempalace_tool("memory_graph_query", "graph_query", "tool_kg_query", entity=request.query), request.limit),
    ),
    ToolSpec(
        name="memory_graph_traverse",
        description="从指定节点遍历 MemPalace 图谱。",
        request_model=MemoryGraphTraverseRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_graph_traverse", "graph_traverse", "tool_traverse_graph", start_room=request.start, max_hops=request.depth),
    ),
    ToolSpec(
        name="memory_kg_add",
        description="向 MemPalace 知识图谱写入一条关系。",
        request_model=MemoryKgAddRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_kg_add", "kg_add", "tool_kg_add", subject=request.subject, predicate=request.predicate, object=request.object, source_closet=request.source),
    ),
    ToolSpec(
        name="memory_kg_timeline",
        description="查看 MemPalace 知识图谱时间线。",
        request_model=MemoryGraphQueryRequest,
        response_model=MemoryResult,
        handler=lambda request: limit_memory_result_items(call_mempalace_tool("memory_kg_timeline", "kg_timeline", "tool_kg_timeline", entity=request.query), request.limit),
    ),
    ToolSpec(
        name="memory_kg_invalidate",
        description="使 MemPalace 知识图谱中的一条关系失效。",
        request_model=MemoryKgInvalidateRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_kg_invalidate", "kg_invalidate", "tool_kg_invalidate", subject=request.subject, predicate=request.predicate, object=request.object),
    ),
    ToolSpec(
        name="memory_create_tunnel",
        description="在 MemPalace room 之间创建 tunnel 关系。",
        request_model=MemoryTunnelCreateRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_create_tunnel", "create_tunnel", "tool_create_tunnel", source_wing="personal", source_room=request.source, target_wing="personal", target_room=request.target, label=request.relationship or ""),
    ),
    ToolSpec(
        name="memory_list_tunnels",
        description="列出 MemPalace tunnel。",
        request_model=MemoryNoArgsRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_list_tunnels", "list_tunnels", "tool_list_tunnels"),
    ),
    ToolSpec(
        name="memory_find_tunnels",
        description="查找 MemPalace tunnel。",
        request_model=MemoryTunnelFindRequest,
        response_model=MemoryResult,
        handler=lambda request: limit_memory_result_items(call_mempalace_tool("memory_find_tunnels", "find_tunnels", "tool_find_tunnels", wing_a=request.query), request.limit),
    ),
    ToolSpec(
        name="memory_follow_tunnels",
        description="从指定 room 出发跟随 MemPalace tunnel。",
        request_model=MemoryTunnelFollowRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_follow_tunnels", "follow_tunnels", "tool_follow_tunnels", wing="personal", room=request.start),
    ),
    ToolSpec(
        name="memory_delete_tunnel",
        description="删除指定 MemPalace tunnel。",
        request_model=MemoryTunnelDeleteRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_delete_tunnel", "delete_tunnel", "tool_delete_tunnel", tunnel_id=request.tunnel_id),
    ),
    ToolSpec(
        name="memory_diary_write",
        description="写入 MemPalace diary 条目。",
        request_model=MemoryDiaryWriteRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_diary_write", "diary_write", "tool_diary_write", agent_name="ymcp", entry=request.entry, topic=request.date or "general"),
    ),
    ToolSpec(
        name="memory_diary_read",
        description="读取 MemPalace diary 条目。",
        request_model=MemoryDiaryReadRequest,
        response_model=MemoryResult,
        handler=lambda request: call_mempalace_tool("memory_diary_read", "diary_read", "tool_diary_read", agent_name="ymcp", last_n=request.limit),
    ),
)


def get_tool_specs() -> tuple[ToolSpec, ...]:
    return TOOL_SPECS

