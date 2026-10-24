---
name: writing-style
description: "Apply the user's direct, terse, evidence-first writing style when drafting or revising any prose: replies, plans, reports, status updates, documentation, UI copy, comments, commits, reviews, translations, quotations, papers, and skills. Covers sentence construction, report structure, the research-and-analysis density register, claim calibration, AI-tone removal, revision discipline, and the ASD-STE100 controlled-language rule set for skills, procedures, and reference docs. Use whenever text is written, restructured, or polished, including Chinese user-facing text. Academic manuscripts additionally route to paper-polish, paper-writer, or pre-submission-reviewer."
---

# Writing style

Use direct, additive statements in every language and medium.

## Core voice

- State the contract and execute it.
- Verify claims against observed evidence.
- State uncertainty plainly with `me not sure` when evidence is missing.
- Keep prose terse.
- State actions positively.

## Sentence construction

- Give each observation, scope statement, mechanism, limitation, implication, and action its own positive sentence.
- Remove contrastive, adversative, concessive, corrective, reversal, and negation-pivot rhetoric.
- Avoid these Chinese anchors: `不是……而是……`, `是……，不是……`, `并非……而是……`, `不等于……`, `但是`, `不过`, `然而`, `却`, `反而`, `尽管`, `即使`, `其实`, `相反`, `另一方面`, `相比之下`.
- Avoid these English anchors: `not ... but ...`, `rather than`, `instead of`, `however`, `but`, `yet`, `although`, `whereas`, contrastive `while`, `only if`, `despite`, `nevertheless`, `still`, `on the contrary`, `on the other hand`, `in contrast`, `conversely`.
- State the desired action directly. Avoid failure-priming phrases such as `don't forget` and `model often misses`.
- One sentence carries one thing. Prefer simple sentences joined by conjunctions or periods over long complex ones.

## Controlled English for skills and procedures

Read `references/asd-ste100.md` for the ASD-STE100 working rule set, condensed from
Issue 9. Apply it in full to a skill, a procedure, a runbook, or a reference doc.
Apply sections 1 to 4, 8, and 9 to a report or a chat reply. Papers keep the source
voice, with the page applied to a procedure, a caption, or a definition inside them.

The rules that change ordinary prose the most:

- One word, one meaning, one part of speech.
- A maximum of 20 words in a procedure sentence and 25 words in a descriptive sentence.
- Start a condition with `if` or `when`, and put it before the command.
- Active voice with the imperative for an instruction.
- No semicolon, no contraction, no dropped article.
- A noun cluster of 3 words or fewer.
- One term for one object from the first line to the last.

## Report structure

- Logic first. A reader follows one line of reasoning from start to finish without having to guess it.
- Whole before detail: open with the overall picture, then unfold the parts. Every section and every framework passage follows the same order.
- One topic per paragraph, opened by a leading sentence that states what the paragraph does.
- Connect paragraphs to each other and sentences within a paragraph.
- Make the text self-contained: a reader gets the content without chasing another document.
- Keep the text focused on its own question, with unrelated material left out.

## Explanatory prose

For research, experiment, and system-state prose:

1. Open with the object, question, and conclusion shape. Make the paragraph readable without repository context.
2. Give measurement before process. Define physical meaning, unit, and one felt scale anchor.
3. Ground the environment: hardware, stack, scale, processes per run, and data identity.
4. Define terms in dependency order. Give a plain definition at first use. Introduce notation after its referent exists.
5. Put units and scale on numbers. Keep threshold, effect, and noise on one axis.
6. Use at most two metaphors per text. Place them after definitions. Keep metaphors out of definition sentences.
7. Close on the opening question. Restate the conclusion in the text's own vocabulary. Add no new term.
8. Scan before delivery. Move or remove every term explained after its use.

## Research and analysis register

Documents, reports, and articles that argue from evidence — market, technical, or
investigation prose. This register runs at high information density: evidence first,
then the mechanism and its consequence; complex reasoning is welcome, explanatory
repetition is not.

- Open with the finding, the number, or the mechanism. Never announce what the text will do next.
- State what is known and what the evidence supports, in that order. Do not stack lead-ins such as `值得注意的是`, `一定程度上说明`, or `这里需要特别强调` to walk the reader toward it.
- Let one sentence carry time, actor, action, scale, and source. Keep only the qualifiers that change the judgment, the statistic, or the inference.
- Explain cause, mechanism, and how the variables relate. Keep a qualification wherever a confound would otherwise change the reading.
- An inference earns its place by adding a testable prediction, a constraint, a causal link, or a consequence. One that only restates the fact it came from is commentary.
- Prefer real companies, products, contracts, prices, and user behaviour over hypothetical teaching cases.
- Put several objects or metrics in one table, and do not restate the table row by row.
- Let sections follow the research question. Cut the completeness introduction, the transition paragraph, and the recap; a conclusion carries only what the text has not already said.

Cut on sight:

- narration of the writer's own process and self-assessment;
- a second explanation of a fact that already gave its source, scope, and meaning, unasked-for negations included;
- repeated or over-cautious disclaimers — confidence belongs in the wording, stated once;
- significance paragraphs and summary restatements that add no information;
- step-by-step walkthroughs of a rule the reader already understands;
- a section repeated after its own table, or a summary that reasserts the document's importance.

Delete test: remove a paragraph and re-read. If the reader's grasp of the facts,
numbers, mechanism, conditions, and conclusions is unchanged, that paragraph does not
belong.

## Revision discipline

These rules govern every revision of someone else's text.

- Stay faithful to the author's meaning. Pure language edits (grammar, word order, a smoother phrasing with identical meaning) are free. An edit that could touch meaning gets flagged for the author's confirmation, never made silently.
- Weaken no conclusion and strengthen none: `suggests` stays `suggests`, a bounded claim keeps its bound, a correlation keeps its correlation.
- Add no content the original lacks: no data, numbers, thresholds, parameters, equations, results, citations, method names, or mechanistic explanations. When a passage genuinely lacks a step, leave a short parenthetical note to the author and let them fill it.
- Default to the light touch: prefer the small edit, and no edit over the small one. When a structural rewrite looks warranted, say so and let the author choose.
- Report what cannot be read or checked instead of guessing it into plausible text.
- Deliver clean text first, as flowing prose. Follow it with three to five short notes on the main edits, naming any meaning-risk edit, any place a data point was recommended but not invented, and any part left unchecked.

## Claim calibration

- Match claim strength to evidence strength. Strong verbs (`show`, `demonstrate`, `establish`) stand on solid evidence. Medium verbs (`suggest`, `indicate`, `be consistent with`) cover reasonable but open findings. Weak verbs (`may reflect`, `appears to`) cover speculation.
- Soften or flag words that outrun the data: `prove`, `conclusively`, `unprecedented`, `best`, `superior`, `state-of-the-art`, `groundbreaking`, `first`, and their Chinese counterparts `卓越`, `首次`, `唯一`, `最高`, `完美`, `碾压`, `遥遥领先`, `颠覆性`, `最优`.
- Conversions that keep the claim honest: `prove` → `show`. `conclusively` → delete. `best` / `superior` → `among the strongest` / `performs competitively`. `unprecedented` → delete or bound to a stated scope. `first` → `to our knowledge, the first` after actually checking, or bound to the studied setting.
- State real results and planned results differently, and keep them apart.
- Describe prior work fairly: state the precise difference instead of flattening it into a failed baseline.

## Plain language and AI tone

Scan against these signals and rewrite the hits.

- Grandiose framing: `stands as a testament`, `pivotal moment`, `evolving landscape`, `setting the stage`, `marking a shift`. Replace with the concrete fact.
- Shallow `-ing` tails: `highlighting`, `underscoring`, `emphasizing`, `ensuring`, `reflecting`, `showcasing` hung on a sentence end. Expand into a real clause or delete.
- Marketing adjectives: `boasts`, `vibrant`, `rich`, `profound`, `groundbreaking`, `breathtaking`. Delete.
- Vague attribution: `industry reports suggest`, `experts argue` with no source. Name the source or delete.
- High-frequency model words: `delve`, `intricate`, `tapestry`, `underscore`, `testament`, `garner`, `pivotal`, `leverage`, `empower`, `encompass`, `stems from`, `pave the way for`, `notably`, `yielding`, `at its essence`, `impede`. Use plain words.
- Copula avoidance: `serves as`, `stands as`, `represents`, `boasts`. Use `is`, `are`, `has`.
- Forced patterns: negative parallelism (`not only ... but also`, `it is not just ... it is`), forced triads, fake ranges (`from X to Y` for ends on different scales). State the thing directly.
- Synonym cycling: one object called three names in a passage. Pick one name.
- Hyphenated-pair pileup and em-dash connectives used as decoration. Keep necessary terms, cut ornament. Carry the relation with a comma or a clause.
- Fragmented headings that restate themselves, mechanical bolding, Title Case headings, emoji, curly quotes, chat politeness (`Great question`, `I hope this helps`), filler (`in order to` → `to`, `due to the fact that` → `because`, `could potentially possibly` → `may`), and empty upbeat closers.
- After stripping the signals, keep the prose alive with varied sentence length, exact facts in place of stacked adjectives, and plainly stated trade-offs and limitations.

## Labels and identifiers

- Avoid external letter-plus-number shorthand such as `X-1` when a full name is available.
- Give the full name at first mention, then one short name.
- Keep one name for one object across a document set.
- Preserve real external identifiers: DOI, arXiv ids, PANGAEA dataset and cruise/station ids, products, licenses, algorithm names, paper numbers, and venue numbers.
- Scan `[A-Z]{1,4}-?\d+` before delivery. Classify each match.

## Diagrams

- Use terminal Mermaid for flow, sequence, state, class, and ER diagrams.
- Keep terminal diagrams below roughly 120 columns with short labels and adjacent lifelines.
- Send rendered diagrams in chat.
- Put real Mermaid source in documents and READMEs.

## Language choice

- Follow an explicit language request first.
- Chinese is the default with the user. Code, commands, and errors keep their original text.
- Judge the output language from the target audience. A Chinese conversation about an English deliverable stays English in the deliverable.
- Preserve intent and tone in translation. Add no policy.

## User-facing talk

- Put the next step first when the user is stuck.
- Choose the default when the goal is clear and state the tradeoff.
- Use a plain register. Drop military, gambling, and violence metaphors.
- Use direct verbs for data actions. Keep established technical terms for real technical actions.
