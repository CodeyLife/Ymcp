# Project Agent Constraints

## Iterative Improvement And Root-Cause Analysis

- Treat tests, benchmark scores, generated samples, and user-reported cases as evidence of a problem, not as the specification of the fix.
- Do not add rules that only recognize a particular title, genre, character name, paragraph, exact phrase, fixture shape, chapter index, or benchmark sample. Do not tune thresholds solely until one known sample passes.
- Before changing code or prompts, identify the observed symptom, the failing workflow layer, the underlying mechanism, the affected class of inputs, and the boundaries of the proposed behavior. Distinguish root causes from downstream manifestations.
- Fix the problem at the lowest shared layer that owns the faulty behavior. Prefer reusable contracts, algorithms, data modeling, validation, or execution hooks over accumulating case-specific prompt prohibitions and examples.
- Prompt examples are illustrative, not normative. Express the general principle and decision rule first; vary examples across genres, roles, points of view, chapter functions, and prose styles so that one fixture cannot become an implicit product contract.
- A valid improvement must explain why it addresses the broader failure class and what it deliberately does not cover. Record meaningful tradeoffs and regression risks when the solution changes behavior outside the original case.
- Validate the original failing case and at least one materially different counterexample or cross-scenario case. For novel generation changes, inspect the actual generated artifacts and workflow transitions in addition to automated scores; a higher benchmark score alone is not proof of improvement.
- If evidence disproves the proposed mechanism, revisit the root-cause analysis instead of adding another exception. If a narrow exception is genuinely required by the domain, state and test that domain boundary explicitly.
- Keep changes scoped, but do not confuse a small diff with a general solution. The implementation should remain minimal while covering the identified class of failures.
