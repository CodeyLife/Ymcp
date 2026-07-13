import { Input, Tag } from "antd";
import { AimOutlined, EnvironmentOutlined } from "@ant-design/icons";
import type { CharacterKnowledge, CharacterState, EntityKind, StoryEntity } from "./types";

type CharacterDetails = NonNullable<StoryEntity["character"]>;

export interface CharacterCardData {
  kind?: EntityKind;
  name?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  character?: Partial<Omit<CharacterDetails, "knowledge" | "state">> & {
    knowledge?: Partial<CharacterKnowledge>;
    state?: Partial<CharacterState>;
  };
}

export function isCharacterEntityData(value: unknown): value is CharacterCardData {
  if (!value || typeof value !== "object") return false;
  const entity = value as Record<string, unknown>;
  return entity.kind === "character" && typeof entity.name === "string";
}

function valueOrFallback(value: string | undefined, fallback: string) {
  return value?.trim() || fallback;
}

function CharacterField({
  label,
  value,
  editable,
  rows = 2,
  onChange,
}: {
  label: string;
  value?: string;
  editable: boolean;
  rows?: number;
  onChange?: (value: string) => void;
}) {
  return <label className="novel-character-card-field">
    <span>{label}</span>
    {editable
      ? <Input.TextArea autoSize={{ minRows: rows, maxRows: Math.max(rows + 2, 4) }} value={value ?? ""} onChange={(event) => onChange?.(event.target.value)} />
      : <p>{valueOrFallback(value, "尚未设定")}</p>}
  </label>;
}

export default function CharacterCard({
  entity,
  mode = "compact",
  editable = false,
  selected = false,
  onChange,
}: {
  entity: CharacterCardData;
  mode?: "rail" | "compact" | "detail";
  editable?: boolean;
  selected?: boolean;
  onChange?: (entity: CharacterCardData) => void;
}) {
  const details = entity.character ?? {};
  const state = details.state ?? {};
  const initial = valueOrFallback(entity.name, "角").slice(0, 1);
  const updateRoot = (patch: Partial<CharacterCardData>) => onChange?.({ ...entity, ...patch });
  const updateDetails = (patch: Partial<CharacterDetails>) => onChange?.({ ...entity, character: { ...details, ...patch } });
  const updateState = (patch: Partial<CharacterState>) => updateDetails({ state: { ...state, ...patch } as CharacterState });

  if (mode === "rail") {
    return <div className={`novel-character-card rail${selected ? " selected" : ""}`}>
      <span className="novel-character-card-avatar">{initial}</span>
      <div className="novel-character-card-identity">
        <strong>{valueOrFallback(entity.name, "未命名角色")}</strong>
        <small>{valueOrFallback(details.role, "角色")}</small>
      </div>
      <small className="novel-character-card-emotion">{valueOrFallback(state.emotional, "状态未知")}</small>
    </div>;
  }

  if (mode === "compact") {
    return <div className="novel-character-card compact">
      <span className="novel-character-card-avatar">{initial}</span>
      <div className="novel-character-card-copy">
        <div className="novel-character-card-title"><strong>{valueOrFallback(entity.name, "未命名角色")}</strong><small>{valueOrFallback(details.role, "角色")}</small></div>
        <p>{valueOrFallback(state.objective || entity.summary, "尚未记录当前目标")}</p>
        <div className="novel-character-card-meta">
          <span><EnvironmentOutlined /> {valueOrFallback(state.location, "位置未知")}</span>
          <span><AimOutlined /> {valueOrFallback(details.desire, "欲望未设定")}</span>
        </div>
      </div>
      <Tag>{valueOrFallback(state.emotional, "未知")}</Tag>
    </div>;
  }

  return <div className="novel-character-card detail">
    <header>
      <span className="novel-character-card-avatar">{initial}</span>
      <div className="novel-character-card-identity">
        {editable
          ? <><Input aria-label="角色姓名" variant="borderless" value={entity.name ?? ""} onChange={(event) => updateRoot({ name: event.target.value })} /><Input aria-label="角色身份" variant="borderless" value={details.role ?? ""} placeholder="角色身份" onChange={(event) => updateDetails({ role: event.target.value })} /></>
          : <><strong>{valueOrFallback(entity.name, "未命名角色")}</strong><small>{valueOrFallback(details.role, "角色")}</small></>}
      </div>
      <Tag>{valueOrFallback(state.emotional, "状态未知")}</Tag>
    </header>

    <CharacterField label="人物摘要" value={entity.summary} editable={editable} rows={2} onChange={(summary) => updateRoot({ summary })} />

    <div className="novel-character-card-state">
      <label><span>当前位置</span>{editable ? <Input value={state.location ?? ""} onChange={(event) => updateState({ location: event.target.value })} /> : <strong>{valueOrFallback(state.location, "未知")}</strong>}</label>
      <label><span>当前情绪</span>{editable ? <Input value={state.emotional ?? ""} onChange={(event) => updateState({ emotional: event.target.value })} /> : <strong>{valueOrFallback(state.emotional, "未知")}</strong>}</label>
      <label><span>当前目标</span>{editable ? <Input value={state.objective ?? ""} onChange={(event) => updateState({ objective: event.target.value })} /> : <strong>{valueOrFallback(state.objective, "未设定")}</strong>}</label>
    </div>

    <div className="novel-character-card-grid">
      <CharacterField label="核心欲望" value={details.desire} editable={editable} onChange={(desire) => updateDetails({ desire })} />
      <CharacterField label="行动动机" value={details.motivation} editable={editable} onChange={(motivation) => updateDetails({ motivation })} />
      <CharacterField label="性格与行为倾向" value={details.personality} editable={editable} onChange={(personality) => updateDetails({ personality })} />
      <CharacterField label="弱点与代价" value={details.weakness} editable={editable} onChange={(weakness) => updateDetails({ weakness })} />
      <CharacterField label="人物秘密" value={details.secret} editable={editable} onChange={(secret) => updateDetails({ secret })} />
      <CharacterField label="人物弧光" value={details.arc} editable={editable} onChange={(arc) => updateDetails({ arc })} />
      <CharacterField label="外貌与辨识度" value={details.appearance} editable={editable} onChange={(appearance) => updateDetails({ appearance })} />
      <CharacterField label="语言与声音" value={details.voice} editable={editable} onChange={(voice) => updateDetails({ voice })} />
    </div>

    {(entity.tags?.length || details.abilities?.length) ? <footer>
      {entity.tags?.map((tag) => <Tag key={`tag-${tag}`}>{tag}</Tag>)}
      {details.abilities?.map((ability) => <Tag color="gold" key={`ability-${ability}`}>{ability}</Tag>)}
    </footer> : null}
  </div>;
}
