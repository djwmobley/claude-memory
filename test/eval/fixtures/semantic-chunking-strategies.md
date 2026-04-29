---
name: semantic-chunking-strategies
description: Chunk boundary selection, overlap, ceiling sizes, and content-type-aware chunking for RAG pipelines
type: reference
---

# Semantic Chunking Strategies

Chunking -- splitting source documents into retrieval units -- is the highest-leverage decision
in a RAG pipeline. A good chunker makes retrieval precise. A bad chunker forces the LLM to
work around irrelevant context or miss the relevant passage entirely.

## Why Chunking Matters

Vector embeddings encode meaning over a fixed token window. If you embed an entire 10,000-word
document as one vector, the embedding is a blurry average of all topics and individual concepts
get washed out. Retrieval returns the document when ANY concept matches -- which floods the
context window with unrelated text.

Conversely, chunks that are too small lose context: a single sentence about "retry backoff"
may embed poorly without the surrounding explanation of what is being retried and why.

The goal is chunks that are: (a) small enough to be topically coherent, (b) large enough to
carry self-contained meaning, and (c) split at natural semantic boundaries.

## Fixed-Size Chunking

The simplest approach: split every N tokens, with an optional overlap of K tokens.

**Advantages:** Trivial to implement, deterministic, no parsing dependency.

**Disadvantages:** Splits mid-sentence, mid-paragraph, or mid-code-block. The overlap
mitigates but does not eliminate boundary damage. Produces embeddings that straddle
two unrelated topics when a topic change happens to fall near the chunk boundary.

**When to use:** Homogeneous plaintext with no clear structure (transcripts, log files).
Use 256-512 tokens per chunk with 15-20% overlap as a starting point.

## Recursive Character Splitting

Split on a priority list of separators: `["\n\n", "\n", ". ", " "]`. Try the first separator;
if any resulting chunk exceeds the ceiling, recurse with the next separator.

This is the most widely used general-purpose strategy and is the default in LangChain's
`RecursiveCharacterTextSplitter`. It respects paragraph boundaries when possible and falls
back gracefully.

**Ceiling:** 512-1024 tokens is typical. Below 256, you lose semantic coherence. Above 2048,
you approach the "blurry average" problem.

**Overlap:** 50-100 tokens. Enough to carry a sentence of context across the boundary
without burning embedding capacity on redundant text.

## Markdown-Aware Chunking

Markdown documents have explicit structure: headings define section boundaries. A
heading-aware chunker splits on `##` or `###` headings and keeps each section as one chunk
(splitting only if the section exceeds the ceiling).

**Key behaviors to implement:**
- Prepend the heading hierarchy to each chunk: `# Parent > ## Section > content`. This
  preserves navigation context when the chunk is retrieved in isolation.
- Include the heading itself in the chunk body, not just as metadata. The embedding model
  needs to see the heading to understand what the chunk is about.
- Never split a code block mid-fence. If a section ends in the middle of a ` ``` ` block,
  extend the chunk to the closing fence.
- If a section is too long, prefer splitting on sub-headings before splitting on paragraphs.

## Code-Aware Chunking

Source code has its own structure. Splitting a function across two chunks breaks the
unit of meaning. Code chunkers should:

- Treat top-level function/class definitions as the natural chunk boundary
- Keep entire function bodies in one chunk (including docstring + body)
- If a function exceeds the ceiling, split at block boundaries (loop body, if-branch)
  rather than mid-expression
- Include the file path and module name as chunk metadata and prepend it as a comment
  in the chunk text

For SQL files, split on DDL statement boundaries (`CREATE TABLE`, `CREATE INDEX`, etc.).
For shell scripts, split on function definitions or logical command groups.

## Overlap Strategy

Overlap is often misunderstood. Its purpose is to preserve context across chunk boundaries,
not to guarantee a passage is captured somewhere. If a critical sentence is at position
N in a chunk and the chunk boundary is at N+5, the sentence appears near the end of one
chunk and near the beginning of the next -- both with poor embedding weight because the
rest of the context pulls the embedding in different directions.

Better approach: treat overlap as a fallback. Prefer structural boundaries (headings,
function definitions) so the overlap rarely needs to do heavy lifting.

Recommended: 10-20% overlap for fixed-size chunking; zero overlap for structure-aware
chunking (the structure already handles the continuity).

## Ceiling Sizes by Content Type

| Content type      | Recommended ceiling | Notes                                  |
|-------------------|---------------------|----------------------------------------|
| Narrative prose   | 512 tokens          | One or two paragraphs                  |
| Technical docs    | 768 tokens          | Heading + explanation + one example    |
| API reference     | 256 tokens          | One endpoint or one parameter group    |
| Source code       | 512 tokens          | One function, including docstring      |
| SQL DDL           | 256 tokens          | One statement                          |
| Markdown tutorial | 1024 tokens         | One section with code                  |
| Log lines         | 128 tokens          | One logical event                      |

## Metadata Enrichment

Every chunk should carry metadata beyond the raw text:

- `source_path` -- original file path or URL
- `chunk_index` -- position within the source document (for ordering recovered fragments)
- `heading_path` -- slash-joined heading hierarchy, e.g. `Installation / Docker / Compose`
- `content_hash` -- hash of the chunk text for deduplication and incremental sync
- `char_start`, `char_end` -- character offsets for reconstructing the source location

Metadata is not embedded -- it lives in the relational side of the store and is joined at
retrieval time to produce citations.

## Evaluating Chunking Quality

The most direct signal is retrieval recall on a golden question set: given a question with
a known answer passage, does the correct chunk rank in the top-3 results?

Failure modes to watch for:

- **Boundary split on the answer:** The answer sentence is split across two chunks, and
  neither chunk alone retrieves well for the query.
- **Context bleed:** A chunk contains two unrelated topics (e.g., the last paragraph of
  one section and the first paragraph of the next), causing retrieval on topic A to surface
  context about topic B.
- **Oversized chunks:** Chunks consistently exceed the ceiling because a structural
  boundary was not recognized. Common in code files where the chunker treats the whole
  file as one unit.
- **Empty or near-empty chunks:** Caused by consecutive structural boundaries (back-to-back
  headings with no body, or empty functions). These waste index space and can rank
  spuriously on partial matches.
