# Sanitized historical investigation record

This is a curated summary of six investigation reports dated **13 September 2026**: routing, compatibility matrix, compaction, remaining CLI checks, messaging/interruption, and native ImageGen. The experiments used official Codex CLI **0.149.1**, `gpt-5.6-sol`, and a separately authenticated backing account through temporary experimental proxies. It preserves evidence for the approach, **not live verification of this extracted package**.

The source reports were reviewed during this repository's handoff. Raw histories, credentials, response bodies, and private reasoning remain outside the repository. No temporary harness or third-party implementation is vendored. This document retains useful methods and limitations without requiring access to a temporary directory.

## Routing intervention

Two protocol defects were corrected together: omitted `session-id`/`thread-id` request headers and discarded upstream `x-codex-turn-state`. The CLI owns turn-state reuse within a turn and reset across turns; the proxy forwards it without inventing or globally persisting state.

A controlled test used 18 requests: two trials each for legacy forwarding, corrected forwarding, and direct access; three requests per trial. Trial identity was stable within a chain and separate across trials, with low reasoning, matched structure, five-second spacing, reversed arm order in the second trial, and no retries/fallback. Saved evidence contained structural flags and usage counters only.

| Arm | Follow-ups with cache | Cached/input tokens | Cached fraction |
|---|---:|---:|---:|
| Legacy proxy | 0/4 | 0/30,204 | 0% |
| Corrected proxy | 4/4 | 29,696/30,218 | 98.27% |
| Direct | 4/4 | 29,696/30,212 | 98.29% |

All 18 completed. A further three-request real CLI workflow performed two local tools, returned the expected marker, and reused roughly 97% cached input on both continuations. This small bundled intervention does not isolate each header's contribution or prove latency equivalence, guaranteed hits, or subscription quota discounts.

## CLI capability matrix

The matrix used 39 live model requests within a cap of 48; all completed after retained harness corrections. It verified:

- Image input via an independently checked random marker and image facts, then follow-up without reattaching the image.
- Six reasoning settings and opaque returned-state reuse, checked using in-memory comparisons without exposing reasoning. The CLI maps `ultra` to `max`.
- Sequential tools with independently checked arithmetic; parallel tools with 1,504.720 ms measured overlap using a shared clock.
- Actual resume, fork, independent parent/child memory, and a real TUI `/side` with return to the parent.
- Session/thread/cache identity, appropriate turn-state replay/reset, and exact forwarding fixtures.

**Isolation incident:** an early synthetic TUI harness accepted a startup update modal and changed the global CLI from 0.149.1 to 0.154.0. It was restored and verified before further live testing. All matrix inference used 0.149.1; none used 0.154.0. This was a failed isolation check that was repaired, not proof of untouched global state. Later isolated configurations disabled startup update checks and the harness aborted on unexpected update dialogs. Primary app authentication/configuration were not edited.

The initial image command's argument parsing, cross-process timing assumptions, and interpretation of outer Code Mode call counts were corrected. The repaired assertions were independently checked; initial failures were not counted as passes. Empty isolated plugin inventory established inventory only, not arbitrary plugin execution.

## Compaction

A separate 26-request run within a cap of 32 verified actual manual TUI `/compact` and automatic threshold-triggered compaction. Both persisted checkpoints, preserved a random project identifier, a corrected fact and prior arithmetic, then supported resume, new tools, forks, and independent branch memory. All 26 requests completed.

Original image items disappeared from compacted histories. Correctly remembered image facts established summary retention, **not continued pixel access**. Maximum-window stress and universal summarization accuracy were not established.

Two audit corrections mattered: final-answer assertions had initially mixed commentary with the final message; and the routing observer initially treated compaction's separate client session as stale normal-turn state. Persisted final messages and properly scoped normal→compaction→normal state checks resolved those harness errors. Across post-compaction non-fork requests, 10/11 hit cache, totaling 88,448/107,979 cached/input tokens (81.91%); initial forks were uncached.

## Extended tools, agents, search, and repeated compaction

An extension used 40 upstream requests: 38 completed model requests, one completed search request, and one model stream without a completion/usage event. It verified:

- Actual file patches with independently checked cases and an unchanged unrelated file.
- Two actual subagents, targeted follow-ups, waits, independent markers, and arithmetic.
- Actual Code Mode `ALL_TOOLS` discovery followed by fixture MCP execution. Removed legacy `tool_search` flags were not credited.
- Actual standalone search after enabling `supports_standalone_web_search` and forwarding `/v1/alpha/search`. The initial correct answer without a web call failed verification; the repaired run had web events, HTTP 200, and an independently verified IANA answer.
- Three persisted compaction cycles, preservation of corrections/task facts, and resumed tool execution.

Parent/subagent requests shared session/cache identity while using different thread IDs; requiring separate sessions had been an incorrect assertion. The generic per-session observer mixed child histories, so its flags did not establish agent routing defects or an agent-aware lifetime audit. One parent stream ended without completion for an unresolved reason; eventual workflow success does not make every request successful. Missing usage was not counted as zero.

Local synthetic fixtures separately checked sibling-stream isolation/cancellation, upstream abort, 429 handling without retries, and request caps. They were not live stress or real token-expiry tests.

## Busy-child messaging and interruption

A low-effort-only extension used 23 Responses requests: 20 with completion/usage, three initial child streams without them. It established delivery of the **actual sent payload** while a child was busy, actual interruption calls reporting a running child, and successful continuation through a bounded recovery run.

The original parent sent a different message than the requested marker instruction and stopped before waiting for recovery. Those original criteria failed. Exact delivery was audited against the actual payload, and resumed completion was checked separately. The second planned wait fixture never started; termination of every tool subprocess was not established. Across completed requests, cache was 192,256/203,189 input tokens (94.62%); this combines cohorts and says nothing about quota savings.

## Native ImageGen: later success supersedes earlier unavailability

Earlier registries omitted ImageGen. Source investigation found an additional core eligibility branch beyond the provider-name gate. The eventual configuration used provider name `OpenAI`, `requires_openai_auth=false`, and a nonempty actor-authorization eligibility marker. The proxy stripped that marker and authenticated only with the isolated backing account. No downstream credentials were copied and no unavailable entitlement was granted.

The actual native tool generated a blue circle and edited the prior image to red using `num_last_images_to_include: 1`. Both image-service calls returned HTTP 200 and saved 1254×1254 PNGs. Independent visual and center/corner pixel checks passed.

There were five completed low-effort model requests and two successful image requests. The initial six-request harness budget blocked the final acknowledgment **after the edit succeeded**; one bounded model-only continuation recovered it without further images. The original CLI exit was therefore a harness-cap failure, not an image-service failure. Later model requests cached 42,496/47,954 input tokens (88.62%); image-service cached counts were unreported.

Masks, multiple edit references, transparency, large images, and desktop behavior remain untested.

## What not to infer

The focused checklist was not universal desktop/plugin parity. Guaranteed caching, original pixels after compaction, auth refresh, broad stress, and quota-accounting claims were explicitly excluded, not passed. The extracted package still needs its own separately authorized bounded smoke test; its local fixtures should preserve this protocol evidence without rerunning the whole investigation.

Source references used by the investigation are linked in [compatibility.md](compatibility.md#research-references). This summary records historical observations, not a new claim about current service behavior.
