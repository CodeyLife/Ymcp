import { describe, expect, it } from "vitest";
import { countNovelCharacters } from "../word-count";

describe("countNovelCharacters", () => {
  it("excludes Chinese punctuation and whitespace", () => {
    expect(countNovelCharacters("风起了。\n“回家吧！” 123")).toBe(9);
  });

  it("counts letters and numbers while excluding symbols across scripts", () => {
    expect(countNovelCharacters("Hello, world! 東京🙂 A-2")).toBe(14);
  });

  it("returns zero for content containing no textual characters", () => {
    expect(countNovelCharacters(" \n……—!?🙂")).toBe(0);
  });
});
