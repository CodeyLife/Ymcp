import { describe, expect, it, vi } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { ySyncPlugin } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { resolveStoredManuscriptHtml, seedEmptyCollaborativeDocument } from "../collaboration";
import { createManuscriptPersistenceGuard, shouldApplyStoredManuscriptContent } from "../persistence";

describe("collaborative manuscript initialization", () => {
  it("does not treat an older save as current after the author keeps typing", () => {
    const guard = createManuscriptPersistenceGuard();
    guard.markEdited();
    const saveVersion = guard.beginSave();
    guard.markEdited();

    expect(guard.isSaveCurrent(saveVersion)).toBe(false);
    expect(shouldApplyStoredManuscriptContent({ saveState: "dirty", editorHtml: "<p>新输入</p>", storedContentHtml: "<p>旧保存</p>" })).toBe(false);
    expect(shouldApplyStoredManuscriptContent({ saveState: "saved", editorHtml: "<p>旧内容</p>", storedContentHtml: "<p>外部更新</p>" })).toBe(true);
  });

  it("seeds stored manuscript HTML when the collaborative document is empty", () => {
    const doc = new Y.Doc();
    const collaboration = { content: doc.getXmlFragment("prosemirror") };
    const setContent = vi.fn(() => true);

    expect(seedEmptyCollaborativeDocument(collaboration, { contentHtml: "<p>已有正文</p>", plainText: "已有正文" }, setContent)).toBe(true);
    expect(setContent).toHaveBeenCalledOnce();
    expect(setContent).toHaveBeenCalledWith("<p>已有正文</p>");

    doc.destroy();
  });

  it("restores content cleared by the first render of an empty Yjs binding", () => {
    const schema = getSchema([StarterKit.configure({ undoRedo: false })]);
    const storedDocument = schema.node("doc", null, [schema.node("paragraph", null, schema.text("已有正文"))]);
    const doc = new Y.Doc();
    const content = doc.getXmlFragment("prosemirror");
    const plugin = ySyncPlugin(content);
    let state = EditorState.create({ schema, doc: storedDocument, plugins: [plugin] });
    let pluginView: ReturnType<NonNullable<typeof plugin.spec.view>> | undefined;
    const view = {
      get state() { return state; },
      dispatch(transaction: Transaction) {
        const previousState = state;
        state = state.apply(transaction);
        pluginView?.update?.(view as never, previousState);
      },
      hasFocus: () => false,
    };
    if (!plugin.spec.view) throw new Error("Yjs sync plugin has no view");
    pluginView = plugin.spec.view(view as never);
    expect(state.doc.textContent).toBe("");

    const restored = seedEmptyCollaborativeDocument(
      { content },
      { contentHtml: "<p>已有正文</p>", plainText: "已有正文" },
      () => {
        view.dispatch(state.tr.replaceWith(0, state.doc.content.size, storedDocument.content));
        return true;
      },
    );

    expect(restored).toBe(true);
    expect(state.doc.textContent).toBe("已有正文");
    expect(content.length).toBeGreaterThan(0);

    pluginView.destroy?.();
    doc.destroy();
  });

  it("keeps an existing collaborative document as the source of truth", () => {
    const doc = new Y.Doc();
    const content = doc.getXmlFragment("prosemirror");
    content.insert(0, [new Y.XmlElement("paragraph")]);
    const setContent = vi.fn(() => true);

    expect(seedEmptyCollaborativeDocument({ content }, { contentHtml: "<p>数据库正文</p>", plainText: "数据库正文" }, setContent)).toBe(false);
    expect(setContent).not.toHaveBeenCalled();

    doc.destroy();
  });

  it("falls back to escaped plain text for imported legacy chapters", () => {
    expect(resolveStoredManuscriptHtml({ plainText: "第一段<&\n\n第二段\n换行" })).toBe("<p>第一段&lt;&amp;</p><p>第二段<br>换行</p>");
  });
});
