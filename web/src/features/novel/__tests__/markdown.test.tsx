import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "../AIWorkbench";

describe("assistant markdown rendering", () => {
  it("renders headings, GFM tables, strikethrough and code blocks", () => {
    const html = renderToStaticMarkup(<MarkdownContent content={`# 修订建议

| 位置 | 建议 |
| --- | --- |
| 开场 | 增加行动 |

~~删除空泛总结~~

\`\`\`text
角色推开门。
\`\`\`
`} />);

    expect(html).toContain("<h1>修订建议</h1>");
    expect(html).toContain("<table>");
    expect(html).toContain("<del>删除空泛总结</del>");
    expect(html).toContain("<pre><code class=\"language-text\"");
  });
});
