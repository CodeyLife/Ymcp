import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ProposalDataCard from "../ProposalDataCard";

describe("proposal data card", () => {
  it("renders nested proposal data as labeled fields instead of raw json", () => {
    const html = renderToStaticMarkup(<ProposalDataCard value={{
      title: "发现缺页",
      summary: "档案数量异常",
      characterIds: ["陆沉", "闻溪"],
      blueprint: { objective: "找到被删除的记录", hook: "缺页上写着主角名字" },
    }} />);

    expect(html).toContain("标题");
    expect(html).toContain("摘要");
    expect(html).not.toContain("张力");
    expect(html).toContain("关联角色");
    expect(html).toContain("目标");
    expect(html).toContain("发现缺页");
    expect(html).not.toContain("&quot;title&quot;");
  });

  it("marks unchanged generic fields separately from changed fields", () => {
    const html = renderToStaticMarkup(<ProposalDataCard
      value={{ title: "发现缺页", summary: "证人改口" }}
      compareTo={{ title: "发现缺页", summary: "档案数量异常" }}
      editable
    />);

    expect(html).toMatch(/data-change-state="unchanged"[^>]*><span>标题<\/span>/);
    expect(html).toMatch(/data-change-state="changed"[^>]*><span>摘要<\/span>/);
  });
});
