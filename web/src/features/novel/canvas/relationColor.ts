/**
 * 关系矩阵颜色编码工具。
 *
 * 基于 EntityRelation.bond 中文文本描述的关键词进行分级着色：
 * - 亲密向关键词（亲密/挚爱/深爱/相恋/倾心/眷恋）→ 绿色背景
 * - 疏远向关键词（疏远/敌对/厌恶/仇视/决裂/反目）→ 红色背景
 * - 对立向关键词（对立/冲突/矛盾/隔阂/争执/嫌隙）→ 红色左边框
 * - 信任向关键词（信任/信赖/托付/倚重）→ 显示绿色角标
 *
 * 多个信号可叠加：一条 bond 文本可同时命中背景、边框、角标。
 */

const AFFINITY_POSITIVE_KEYWORDS = ["亲密", "挚爱", "深爱", "相恋", "倾心", "眷恋", "相爱", "心意相通", "情投意合", "如胶似漆"];
const AFFINITY_NEGATIVE_KEYWORDS = ["疏远", "敌对", "厌恶", "仇视", "决裂", "反目", "冷漠", "形同陌路", "水火不容"];
const CONFLICT_KEYWORDS = ["对立", "冲突", "矛盾", "隔阂", "争执", "嫌隙", "摩擦", "裂痕", "不和", "对抗"];
const TRUST_KEYWORDS = ["信任", "信赖", "托付", "倚重", "深信", "推心置腹"];

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

/**
 * 根据 bond 文本返回单元格背景色。
 * 亲密向 → 绿色，疏远向 → 红色，其余 → 无背景。
 */
export function bondToBackground(bond: string): string | undefined {
  const text = bond ?? "";
  if (matchesAny(text, AFFINITY_POSITIVE_KEYWORDS)) {
    return "hsla(120, 45%, 45%, 0.28)";
  }
  if (matchesAny(text, AFFINITY_NEGATIVE_KEYWORDS)) {
    return "hsla(0, 50%, 50%, 0.28)";
  }
  return undefined;
}

/**
 * 根据 bond 文本返回红色左边框颜色（命中对立/冲突类关键词时）。
 */
export function bondToBorder(bond: string): string | undefined {
  const text = bond ?? "";
  if (matchesAny(text, CONFLICT_KEYWORDS)) {
    return "hsla(0, 70%, 55%, 0.6)";
  }
  return undefined;
}

/**
 * 根据 bond 文本判断是否显示高信任角标。
 */
export function bondToTrustDot(bond: string): boolean {
  return matchesAny(bond ?? "", TRUST_KEYWORDS);
}
