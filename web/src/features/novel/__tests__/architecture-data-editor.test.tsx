import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ArchitectureDataEditor, { type ArchitectureEditableData } from "../ArchitectureDataEditor";

const architecture: ArchitectureEditableData = {
  framework: "three-act",
  status: "draft",
  centralQuestion: "主角是否愿意承担真相的代价？",
  centralConflict: "记忆管理局与民间记录者争夺城市历史。",
  synopsis: "一名记录员发现城市的共同记忆正在被人为改写。",
  phases: [{ id: "phase-1", title: "缺口出现", purpose: "建立异常并迫使主角行动", turningPoint: "主角发现自己的档案也是伪造的", order: 0, locked: false }],
};

describe("architecture data editor", () => {
  it("renders the same domain labels and phase layout used by the architecture workspace", () => {
    const html = renderToStaticMarkup(<ArchitectureDataEditor value={architecture} onChange={() => undefined} />);
    expect(html).toContain("结构方法");
    expect(html).toContain("核心问题");
    expect(html).toContain("全书梗概");
    expect(html).toContain("宏观阶段");
    expect(html).toContain("缺口出现");
    expect(html).toContain("添加幕");
  });

  it("keeps the domain presentation but hides mutation controls in before-data previews", () => {
    const html = renderToStaticMarkup(<ArchitectureDataEditor value={architecture} readOnly preview />);
    expect(html).toContain("主角是否愿意承担真相的代价");
    expect(html).toContain("主角发现自己的档案也是伪造的");
    expect(html).not.toContain("添加幕");
    expect(html).not.toContain("删除缺口出现");
  });

  it("marks unchanged architecture fields and changed phase fields in comparison mode", () => {
    const compared: ArchitectureEditableData = {
      ...architecture,
      centralConflict: "管理局开始公开销毁民间档案。",
      phases: architecture.phases.map((phase) => ({ ...phase, purpose: "迫使主角公开第一份异常档案" })),
    };
    const html = renderToStaticMarkup(<ArchitectureDataEditor value={compared} compareTo={architecture} preview />);

    expect(html).toMatch(/data-change-state="unchanged"[^>]*><span>核心问题<\/span>/);
    expect(html).toMatch(/data-change-state="changed"[^>]*><span>核心冲突<\/span>/);
    expect(html).toMatch(/data-change-state="changed"[^>]*><span>叙事使命<\/span>/);
    expect(html).toMatch(/data-change-state="unchanged"[^>]*><span>不可逆转折<\/span>/);
  });
});
