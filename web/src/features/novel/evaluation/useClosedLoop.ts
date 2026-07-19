/**
 * 闭环评估 React Hook：把 `runClosedLoop` 编排函数包装为带 loading/error/result 状态的可调用 hook。
 *
 * 设计依据：
 * - 编排逻辑：[closed-loop.ts](./closed-loop.ts) 的 `runClosedLoop`
 * - Hook 风格：参考 [canvas/useCanvasPanel.ts](../canvas/useCanvasPanel.ts) 的 useState+useRef 模式
 *   + [GenerationComposer.tsx](../GenerationComposer.tsx) 的 `actionInFlight` 防重入模式
 *
 * 职责边界：
 * - 本 hook **只管状态**（busy/error/result）和 **防重入**（同一时刻只允许一个闭环运行）。
 * - 不感知 UI（按钮、Modal、Toast 由调用方渲染）。
 * - 不感知 thread/brief 解析（由调用方从 WorkflowCenter 现有 state 传入）。
 * - 不直接访问 `novelDb`——通过 `canonicalDb` 参数注入，便于测试。
 *
 * 取消语义：React 的 `cancelled` flag 仅用于"卸载后不更新 state"，**不会中断**
 * `runClosedLoop` 的实际执行（其内部包含 LLM 调用和工作流，无法安全中断）。
 * 调用方若需要"用户取消"语义，应通过 UI 禁用按钮 + 提示用户等待当前 run 完成。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { promoteClosedLoopCandidate, runClosedLoop, type ClosedLoopOptions, type ClosedLoopResult } from "./closed-loop";
import type { NovelDatabase } from "../db";

/** 静态参数：在 hook 生命周期内不会变化的标识符与数据库句柄。 */
export interface UseClosedLoopParams {
  /** 正式库实例（UI 传入全局 novelDb；测试可传入 mock）。 */
  canonicalDb: NovelDatabase;
  projectId: string;
  chapterId: string;
  threadId: string;
  briefId: string;
  /** 写入 candidate.provenance.codeRevision；默认 "ui-closed-loop-v1"。 */
  codeRevision?: string;
  /** 写入 AuthorDecision.authorId；默认 "ui-user"。 */
  authorId?: string;
}

/** 单次调用的可变参数。 */
export interface UseClosedLoopRunOptions {
  /** 若为 true，仅执行 inspect 不执行 promote；默认 false。 */
  dryRun?: boolean;
  /** 工作流指令（透传给 startChapterWorkflow.instruction）。 */
  instruction?: string;
  /** 实验标识符；不传时由 runClosedLoop 自动生成。 */
  experimentId?: string;
}

export interface UseClosedLoopResult {
  /** 触发一次闭环评估。若当前已有 run 在执行，则忽略并返回 undefined。 */
  run: (options?: UseClosedLoopRunOptions) => Promise<ClosedLoopResult | undefined>;
  /** 晋升最近一次 dry-run 产生并已展示的确切候选，不重新生成。 */
  promote: () => Promise<ClosedLoopResult | undefined>;
  /** 是否有 run 正在执行。 */
  busy: boolean;
  /** 最近一次 run 的错误信息（成功后清空）。 */
  error: string | undefined;
  /** 最近一次 run 的结果（开始新 run 时清空）。 */
  result: ClosedLoopResult | undefined;
  /** 重置 error + result，不中断进行中的 run。 */
  reset: () => void;
}

/**
 * 把 `runClosedLoop` 包装为 React 状态 hook。
 *
 * 调用方典型用法：
 * ```tsx
 * const closedLoop = useClosedLoop({
 *   canonicalDb: novelDb,
 *   projectId,
 *   chapterId: document.id,
 *   threadId: conversationThread.id,
 *   briefId: creativeBrief.id,
 * });
 * // 渲染按钮：
 * <Button loading={closedLoop.busy} onClick={() => closedLoop.run({ dryRun: true })}>
 *   闭环试运行
 * </Button>
 * // 渲染结果 Modal：
 * {closedLoop.result && <ClosedLoopResultModal result={closedLoop.result} ... />}
 * ```
 */
export function useClosedLoop(params: UseClosedLoopParams): UseClosedLoopResult {
  const { canonicalDb, projectId, chapterId, threadId, briefId, codeRevision, authorId } = params;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<ClosedLoopResult | undefined>(undefined);

  // 防重入：runClosedLoop 内部含 LLM 调用 + 工作流，可能耗时数分钟。
  // 即使 setBusy 还没刷新，ref 也能立即阻止第二次调用进入。
  const inFlightRef = useRef(false);
  const identityKey = `${projectId}\u0000${chapterId}\u0000${threadId}\u0000${briefId}`;
  const identityRef = useRef(identityKey);
  identityRef.current = identityKey;
  // 卸载标志：组件卸载后不再更新 state（但不中断 runClosedLoop 执行）。
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);
  useEffect(() => {
    inFlightRef.current = false;
    setBusy(false);
    setError(undefined);
    setResult(undefined);
  }, [projectId, chapterId, threadId, briefId]);

  const run = useCallback(
    async (options?: UseClosedLoopRunOptions): Promise<ClosedLoopResult | undefined> => {
      if (inFlightRef.current) {
        // 已有 run 在执行——直接返回，避免并发污染状态。
        return undefined;
      }
      inFlightRef.current = true;
      const runIdentity = identityRef.current;
      setBusy(true);
      setError(undefined);
      setResult(undefined);

      const closedLoopOptions: ClosedLoopOptions = {
        canonicalDb,
        projectId,
        chapterId,
        threadId,
        briefId,
        codeRevision: codeRevision ?? "ui-closed-loop-v1",
        authorId: authorId ?? "ui-user",
        dryRun: options?.dryRun ?? false,
        instruction: options?.instruction,
        experimentId: options?.experimentId,
      };

      try {
        const res = await runClosedLoop(closedLoopOptions);
        if (unmountedRef.current || identityRef.current !== runIdentity) return res;
        setResult(res);
        return res;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!unmountedRef.current && identityRef.current === runIdentity) {
          setError(message);
        }
        return undefined;
      } finally {
        if (!unmountedRef.current && identityRef.current === runIdentity) {
          setBusy(false);
          inFlightRef.current = false;
        }
      }
    },
    [canonicalDb, projectId, chapterId, threadId, briefId, codeRevision, authorId],
  );

  const reset = useCallback(() => {
    setError(undefined);
    setResult(undefined);
  }, []);

  const promote = useCallback(async (): Promise<ClosedLoopResult | undefined> => {
    if (inFlightRef.current || !result) return undefined;
    inFlightRef.current = true;
    const promoteIdentity = identityRef.current;
    setBusy(true);
    setError(undefined);
    try {
      const promoted = await promoteClosedLoopCandidate({
        canonicalDb,
        candidate: result.candidate,
        authorId: authorId ?? "ui-user",
      });
      const nextResult: ClosedLoopResult = {
        ...result,
        check: promoted.check,
        receipt: promoted.receipt,
        canonicalHashAfter: promoted.canonicalHashAfter,
      };
      if (!unmountedRef.current && identityRef.current === promoteIdentity) setResult(nextResult);
      return nextResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!unmountedRef.current && identityRef.current === promoteIdentity) setError(message);
      return undefined;
    } finally {
      if (!unmountedRef.current && identityRef.current === promoteIdentity) {
        setBusy(false);
        inFlightRef.current = false;
      }
    }
  }, [authorId, canonicalDb, result]);

  return { run, promote, busy, error, result, reset };
}
