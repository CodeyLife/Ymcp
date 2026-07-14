import { useMemo, useState } from "react";
import { Input, Select, Tooltip } from "antd";

import type { EntityRelation, StoryEntity } from "../types";
import { bondToBackground, bondToBorder, bondToTrustDot } from "./relationColor";

export interface RelationMatrixViewProps {
  entities: StoryEntity[];
  relations: EntityRelation[];
  onEditRelation: (relation: EntityRelation) => void;
  onCreateRelation: (fromId: string, toId: string) => void;
  onEditCharacter: (entity: StoryEntity) => void;
}

type SortBy = "name-asc" | "relations-desc" | "tags";

const SORT_OPTIONS: Array<{ value: SortBy; label: string }> = [
  { value: "name-asc", label: "按名称" },
  { value: "relations-desc", label: "按关系数" },
  { value: "tags", label: "按标签" },
];

/**
 * 关系矩阵视图。
 *
 * 行 = fromEntity,列 = toEntity,呈现 EntityRelation 的有向关系。
 * 单元格通过颜色编码(亲密度→背景、冲突→边框、信任→角标)让所有关系对一眼可读。
 * 空单元格表示该对角色尚未建立关系,点击可直接创建。
 */
export default function RelationMatrixView({
  entities,
  relations,
  onEditRelation,
  onCreateRelation,
  onEditCharacter,
}: RelationMatrixViewProps) {
  const [searchKeyword, setSearchKeyword] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("name-asc");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const relationIndex = useMemo(() => {
    const map = new Map<string, Map<string, EntityRelation>>();
    for (const relation of relations) {
      const inner = map.get(relation.fromEntityId) ?? new Map<string, EntityRelation>();
      inner.set(relation.toEntityId, relation);
      map.set(relation.fromEntityId, inner);
    }
    return map;
  }, [relations]);

  const relationCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const relation of relations) {
      counts.set(relation.fromEntityId, (counts.get(relation.fromEntityId) ?? 0) + 1);
      counts.set(relation.toEntityId, (counts.get(relation.toEntityId) ?? 0) + 1);
    }
    return counts;
  }, [relations]);

  const visibleEntities = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();
    const filtered = keyword
      ? entities.filter(
          (e) =>
            e.name.toLowerCase().includes(keyword) ||
            e.aliases.some((alias) => alias.toLowerCase().includes(keyword)) ||
            e.tags.some((tag) => tag.toLowerCase().includes(keyword)),
        )
      : entities;
    const sorted = [...filtered];
    if (sortBy === "name-asc") {
      sorted.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    } else if (sortBy === "relations-desc") {
      sorted.sort((a, b) => (relationCount.get(b.id) ?? 0) - (relationCount.get(a.id) ?? 0));
    } else if (sortBy === "tags") {
      sorted.sort((a, b) => {
        const ta = a.tags[0] ?? "~~";
        const tb = b.tags[0] ?? "~~";
        return ta.localeCompare(tb, "zh-CN");
      });
    }
    return sorted;
  }, [entities, searchKeyword, sortBy, relationCount]);

  if (entities.length === 0) return null;
  if (visibleEntities.length === 0) {
    return (
      <div className="novel-relation-matrix-empty">
        <span>没有匹配的角色</span>
      </div>
    );
  }

  const cellSize = 84;
  const headerSize = 140;
  const gridTemplateColumns = `${headerSize}px repeat(${visibleEntities.length}, ${cellSize}px)`;

  return (
    <div className="novel-relation-matrix-wrapper">
      <div className="novel-relation-matrix-toolbar">
        <Input.Search
          allowClear
          placeholder="按角色名/别名/标签搜索"
          value={searchKeyword}
          onChange={(event) => setSearchKeyword(event.target.value)}
          style={{ maxWidth: 280 }}
        />
        <Select
          value={sortBy}
          options={SORT_OPTIONS}
          onChange={(value) => setSortBy(value)}
          style={{ width: 130 }}
        />
        <span className="novel-relation-matrix-meta">
          {visibleEntities.length} 角色 · {relations.length} 关系
        </span>
      </div>

      <div className="novel-relation-matrix-scroll">
        <div
          className="novel-relation-matrix"
          style={{ gridTemplateColumns }}
        >
          <div className="novel-relation-matrix-corner" />
          {visibleEntities.map((entity) => (
            <Tooltip key={`col-${entity.id}`} title={`${entity.name}${entity.tags.length ? ` · ${entity.tags.join("/")}` : ""}`}>
              <button
                type="button"
                className={`novel-relation-matrix-header-col${highlightedId === entity.id ? " highlighted" : ""}`}
                onClick={() => setHighlightedId((prev) => (prev === entity.id ? null : entity.id))}
                onDoubleClick={() => onEditCharacter(entity)}
              >
                <span className="novel-relation-matrix-header-name">{entity.name}</span>
              </button>
            </Tooltip>
          ))}

          {visibleEntities.map((rowEntity) => (
            <RowFragment
              key={`row-${rowEntity.id}`}
              rowEntity={rowEntity}
              colEntities={visibleEntities}
              relationIndex={relationIndex}
              highlightedId={highlightedId}
              onEditRelation={onEditRelation}
              onCreateRelation={onCreateRelation}
              onEditCharacter={onEditCharacter}
              onHighlight={(id) => setHighlightedId((prev) => (prev === id ? null : id))}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface RowFragmentProps {
  rowEntity: StoryEntity;
  colEntities: StoryEntity[];
  relationIndex: Map<string, Map<string, EntityRelation>>;
  highlightedId: string | null;
  onEditRelation: (relation: EntityRelation) => void;
  onCreateRelation: (fromId: string, toId: string) => void;
  onEditCharacter: (entity: StoryEntity) => void;
  onHighlight: (id: string) => void;
}

function RowFragment({
  rowEntity,
  colEntities,
  relationIndex,
  highlightedId,
  onEditRelation,
  onCreateRelation,
  onEditCharacter,
  onHighlight,
}: RowFragmentProps) {
  return (
    <>
      <Tooltip title={`${rowEntity.name}${rowEntity.tags.length ? ` · ${rowEntity.tags.join("/")}` : ""}`}>
        <button
          type="button"
          className={`novel-relation-matrix-header-row${highlightedId === rowEntity.id ? " highlighted" : ""}`}
          onClick={() => onHighlight(rowEntity.id)}
          onDoubleClick={() => onEditCharacter(rowEntity)}
        >
          <span className="novel-relation-matrix-header-name">{rowEntity.name}</span>
        </button>
      </Tooltip>
      {colEntities.map((colEntity) => {
        if (rowEntity.id === colEntity.id) {
          return (
            <div
              key={`cell-${rowEntity.id}-${colEntity.id}`}
              className="novel-relation-matrix-cell diagonal"
              onDoubleClick={() => onEditCharacter(rowEntity)}
            >
              <span>{rowEntity.name.slice(0, 1)}</span>
            </div>
          );
        }
        const relation = relationIndex.get(rowEntity.id)?.get(colEntity.id);
        const isHighlighted = highlightedId === rowEntity.id || highlightedId === colEntity.id;
        if (!relation) {
          return (
            <button
              key={`cell-${rowEntity.id}-${colEntity.id}`}
              type="button"
              className={`novel-relation-matrix-cell empty${isHighlighted ? " highlighted" : ""}`}
              onClick={() => onCreateRelation(rowEntity.id, colEntity.id)}
              title={`创建关系:${rowEntity.name} → ${colEntity.name}`}
            >
              <span>+</span>
            </button>
          );
        }
        const background = bondToBackground(relation.bond);
        const borderLeft = bondToBorder(relation.bond);
        const showTrustDot = bondToTrustDot(relation.bond);
        return (
          <button
            key={`cell-${rowEntity.id}-${colEntity.id}`}
            type="button"
            className={`novel-relation-matrix-cell${isHighlighted ? " highlighted" : ""}`}
            style={{
              background,
              borderLeftColor: borderLeft,
              borderLeftWidth: borderLeft ? "3px" : undefined,
              borderLeftStyle: borderLeft ? "solid" : undefined,
            }}
            onClick={() => onEditRelation(relation)}
            title={`${rowEntity.name} → ${colEntity.name}\n${relation.relationType}${relation.bond ? ` · ${relation.bond}` : ""}`}
          >
            <span className="novel-relation-matrix-cell-type">{relation.relationType}</span>
            <span className="novel-relation-matrix-cell-bond">{relation.bond || "—"}</span>
            {showTrustDot && <i className="novel-relation-matrix-cell-trust" aria-label="高信任" />}
          </button>
        );
      })}
    </>
  );
}
