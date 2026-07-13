import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ProposalDataCard from "../ProposalDataCard";

describe("proposal data card", () => {
  it("renders nested proposal data as labeled fields instead of raw json", () => {
    const html = renderToStaticMarkup(<ProposalDataCard value={{
      title: "发现缺页",
      causality: "档案数量异常",
      tension: 72,
      characterIds: ["陆沉", "闻溪"],
      blueprint: { objective: "找到被删除的记录", hook: "缺页上写着主角名字" },
    }} />);

    expect(html).toContain("标题");
    expect(html).toContain("因果");
    expect(html).toContain("张力");
    expect(html).toContain("关联角色");
    expect(html).toContain("目标");
    expect(html).toContain("发现缺页");
    expect(html).not.toContain("&quot;title&quot;");
  });
});
