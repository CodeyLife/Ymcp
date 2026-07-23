import type { ChapterBlueprint, CreativeBrief } from "./types";

const INTERNAL_STATE_SOURCE = "感受|觉得|认为|意识|明白|知道|发现|察觉|心想|疑惑|不安|担心|克制|好奇|熟悉|判断|决定|想要|希望|恐惧|犹豫";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasDelegatedMentalSubject(segment: string) {
  const causatives = [...segment.matchAll(/使得|迫使|提醒|使|令|叫|让(?!步|路|开|座|位)/g)];
  const causative = causatives.at(-1);
  if (!causative || causative.index === undefined) return false;
  const governed = segment.slice(causative.index + causative[0].length);
  return /[他她它](?:自己)?/.test(governed);
}

export function findBlueprintPovConflicts(data: Record<string, unknown>, otherCharacterNames: string[], requireThirdPerson = false) {
  const candidates: Array<{ field: string; text: string }> = [
    { field: "章节目标", text: String(data.objective ?? "") },
    { field: "起点", text: String(data.startingState ?? "") },
    { field: "章尾驱动力", text: String(data.endingHook ?? "") },
  ];
  if (Array.isArray(data.mustHappen)) {
    data.mustHappen.forEach((item, index) => {
      candidates.push({ field: `必写 ${index + 1}`, text: String(item ?? "") });
    });
  }
  if (Array.isArray(data.beats)) {
    for (const [index, beat] of data.beats.entries()) {
      if (!beat || typeof beat !== "object") continue;
      candidates.push({ field: `节拍 ${index + 1} 情绪`, text: String((beat as Record<string, unknown>).emotion ?? "") });
    }
  }
  return candidates.flatMap((candidate) => {
    const firstPersonConflict = requireThirdPerson && /(^|[，。；：\s])我(?:在|从|看|听|闻|感|想|走|站|停|伸|抬|低|回|仍|也|只|却)/.test(candidate.text);
    // 只有代词在使役结构中直接充当心理动词主语时，心理状态才不属于前面的角色名。
    // 代词作为宾语、领属语或更早句子成分时，不能据此跳过整次匹配。
    const otherMindConflict = otherCharacterNames.some((name) => {
      const re = new RegExp(`${escapeRegExp(name)}([^，。；：！？]{0,20})(?:${INTERNAL_STATE_SOURCE})`, "g");
      let match: RegExpExecArray | null;
      while ((match = re.exec(candidate.text)) !== null) {
        const segment = (match[1] ?? "").trim();
        const delegatedSubject = hasDelegatedMentalSubject(segment);
        if (delegatedSubject) continue;
        return true;
      }
      return false;
    });
    return firstPersonConflict || otherMindConflict ? [candidate] : [];
  });
}

export function applyCreativeBriefToBlueprint(blueprint: ChapterBlueprint, brief: CreativeBrief): ChapterBlueprint {
  const characterIds = new Set(blueprint.characterIds);
  if (brief.povCharacterId) characterIds.add(brief.povCharacterId);
  return {
    ...blueprint,
    povCharacterId: brief.povCharacterId,
    characterIds: [...characterIds],
    mustHappen: [...new Set([...brief.mustHappen, ...blueprint.mustHappen])],
    forbidden: [...new Set([...brief.forbidden, ...blueprint.forbidden])],
    targetWords: brief.targetWords,
  };
}

export function formatCreativeBriefContract(brief: CreativeBrief, povName?: string) {
  return `## 已确认创作简报（作者硬约束，优先级高于大纲和检索资料）
- POV：${brief.povCharacterId ? `${povName || "指定角色"}（ID: ${brief.povCharacterId}）` : "未指定；蓝图不得擅自进入任何角色的内心"}
- 创作目标：${brief.goal}
- 基调：${brief.tone || "沿用项目基调"}
- 语言要求：${brief.languageRequirements.join("；") || "沿用项目文风"}
- 必写：${brief.mustHappen.join("；") || "无"}
- 禁写：${brief.forbidden.join("；") || "无"}
- 目标字数：${brief.targetWords}

所有节拍、情绪和内心活动必须服从上述 POV。不得描写 POV 角色无法感知的他人内心；不得把其他角色误写成视角人物。
字段级硬约束：objective、startingState、endingHook、mustHappen 和每个 beats.emotion 只能描述指定 POV 可感知、可推断或可被告知的事项。其他角色可以在 beats.action/outcome 中执行可观察动作，但这些受限字段不得把其他角色姓名与“感受、觉得、意识到、知道、发现、察觉、疑惑、不安、判断、决定、熟悉、克制”等内心词连用。`;
}
