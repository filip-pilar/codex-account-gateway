# Compatibility evidence

Historical isolated tests: 13 September 2026, official Codex CLI 0.149.1, GPT-5.6 Sol orchestration, separate backing ChatGPT account. Tests ran against a temporary experimental proxy. This project reimplements that boundary; historical results are not a live certification of this checkout.

A curated record of methods, request accounting, repaired failures, and the CLI update isolation incident is preserved in [evidence.md](evidence.md). Local versus opt-in live checks for this package are described in [verification.md](verification.md).

## Observed working in the experimental setup

- Text, streaming, local image reading and image follow-ups.
- Six reasoning settings; returned private reasoning state preserved without exposing it. CLI normalized ultra to max.
- Sequential and parallel local tools, file edits, actual subagents, follow-up messages, running-agent interruption and continuation.
- Resume, forks, independent parent/child continuation and actual TUI side conversations.
- Local manual/automatic compaction, repeated compaction and subsequent tools/resume.
- Code Mode deferred tool discovery, local MCP execution and standalone web search.
- Native ImageGen generation and editing through the backing account.

Plugin inventory was checked, not arbitrary plugin execution or desktop/account-backed feature parity. Synthetic cancellation/concurrency/error fixtures do not establish every possible live recovery scenario.

## Routing and caching

Preserving session-id, thread-id, routing hints and returned turn state corrected an earlier experimental proxy's cache misses. In a controlled sample, fixed-proxy follow-ups hit 4/4 at approximately 98.27% cached input, compared with direct native 4/4 at 98.29%. These are small historical samples, not service guarantees. Initial requests and initial fork/side requests were measured separately from later branch turns.

## Native ImageGen

The initial custom provider hid the native tool. A provider configuration using the official CLI's actor-authorization eligibility branch exposed it without giving the downstream client a separate ChatGPT login. The proxy stripped the marker and authenticated upstream with the isolated backing account.

One blue-circle generation and one red-circle edit returned HTTP 200 and independently inspected 1254×1254 PNGs. The edit selected the preceding image with `num_last_images_to_include: 1`. Five low-reasoning model requests and two image requests were used. The original six-request harness budget blocked the final acknowledgment after the image edit succeeded; one bounded continuation completed without additional image generation.

| Request | Input tokens | Cached tokens |
|---|---:|---:|
| Initial model | 9,470 | 0 |
| Model tool continuation | 9,626 | 9,344 |
| Image generation | 56 | Not reported |
| Model after generation | 11,952 | 9,472 |
| Model edit request | 12,030 | 11,776 |
| Image edit | 1,591 | Not reported |
| Model acknowledgment recovery | 14,346 | 11,904 |

Later model requests: 42,496 / 47,954 input tokens cached (88.62%). Image-service cached counts were not assumed zero.

## Scope deliberately excluded

Guaranteed cache hits, original-image retention across compaction, broad stress tests, quota accounting, authentication refresh, and desktop-only capabilities were removed from the focused checklist. Removal does not mean they passed. Masks, multiple edit references, transparency and large images remain untested.

## Research references

- [Official Codex CLI source](https://github.com/openai/codex/tree/rust-v0.149.1)
- [Native tool eligibility](https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/core/src/tools/spec_plan.rs)
- [codex-lb integration notes](https://github.com/Soju06/codex-lb/blob/main/openspec/specs/images-api-compat/context.md)

References informed investigation; no source from these projects is vendored here.
