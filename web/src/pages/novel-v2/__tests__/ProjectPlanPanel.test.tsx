import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanPayloadEditor } from "../ProjectPlanPanel";

describe("PlanPayloadEditor", () => {
  it("shows every author-facing planning field, including nested structured data", () => {
    const html = renderToStaticMarkup(
      <PlanPayloadEditor
        payload={{
          title: "人物关系规划",
          summary: "摘要可见",
          sections: [{
            heading: "核心关系",
            content: "关系会在共同承担代价后发生变化。",
            items: [{
              label: "林澈与周遥",
              detail: "从互相试探转为有限信任",
              attributes: { tension: 4, reversible: true },
            }],
          }],
          structuredData: {
            characters: [{ name: "林澈", motivations: ["自保", "查明真相"] }],
            revealWindow: 12,
          },
        }}
        onChange={() => undefined}
      />,
    );

    for (const content of [
      "人物关系规划",
      "关系会在共同承担代价后发生变化。",
      "林澈与周遥",
      "从互相试探转为有限信任",
      "tension",
      "reversible",
      "characters",
      "林澈",
      "motivations",
      "查明真相",
      "revealWindow",
    ]) expect(html).toContain(content);
  });
});
