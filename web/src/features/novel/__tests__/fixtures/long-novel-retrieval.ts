import type { LexicalRetrievalUnit } from "../../retrieval-evaluation";

const groups = [
  { prefix: "cross", label: "跨章", queries: ["北港旧案卷宗", "第七码头钥匙", "红塔停电记录", "雨夜失踪名单", "旧报馆暗门", "巡夜船航线"] },
  { prefix: "alias", label: "别名", queries: ["阿默", "铁算盘", "白鸦", "小满", "三叔公", "灰医生"] },
  { prefix: "time", label: "时间", queries: ["霜降钟响之前", "第三次月蚀之后", "旧历六月初七", "停战第九日", "冬至午夜", "潮汐倒转当天"] },
  { prefix: "knowledge", label: "角色认知", queries: ["林默知道密钥", "苏岚怀疑内鬼", "程野误认凶手", "闻夏不知道血缘", "顾舟察觉监听", "陆遥相信伪证"] },
  { prefix: "correction", label: "旧决定更正", queries: ["父亲身份更正", "港口位置更正", "死因结论更正", "组织首领更正", "失踪日期更正", "密室入口更正"] },
] as const;

export const longNovelUnits: LexicalRetrievalUnit[] = groups.flatMap((group) => group.queries.map((query, index) => ({
  id: `${group.prefix}-${index + 1}`,
  title: `${group.label}证据 ${index + 1}`,
  content: `${query}。该条目保留章节、故事时点和来源修订，可用于追溯。`,
  aliases: [query],
})));

export const longNovelCases = groups.flatMap((group) => group.queries.map((query, index) => ({
  query,
  relevantIds: [`${group.prefix}-${index + 1}`],
})));
