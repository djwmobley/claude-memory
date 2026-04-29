---
name: frontmatter-yaml-spec
description: Minimal YAML frontmatter rules for markdown memory entries -- syntax, escaping, and common gotchas
type: reference
---

# Frontmatter YAML Spec

Markdown memory entries use YAML frontmatter -- a block between `---` delimiters at the
top of the file. YAML is human-readable but has several edge cases that cause silent
parse errors.

## Minimal Valid Frontmatter

```yaml
---
name: my-entry-name
description: A one-line summary of this entry
type: reference
---
```

Field rules:
- `name`: required. Kebab-case or human-readable. No newlines.
- `description`: required. Single line. Used as the description column.
- `type`: required. One of `project`, `feedback`, `reference`, `user`.

## String Quoting Rules

YAML strings do NOT need quotes in most cases. Quotes are required when:

1. The value starts with a special character: `{`, `[`, `"`, `'`, `|`, `>`, `:`, `#`, `&`, `*`, `!`
2. The value contains a colon followed by a space: `key: value` (parsed as a nested map)
3. The value is a boolean-looking word: `true`, `false`, `yes`, `no`, `on`, `off`
4. The value is a number-looking string: `"123"` (quote to keep as string)
5. The value spans multiple lines

```yaml
# These need quoting:
description: "Error handling: retry and jitter"   # colon-space inside
name: "true"                                       # would parse as boolean
version: "3.14"                                    # would parse as float

# These do NOT need quoting:
name: vector-indexes-postgres
description: HNSW vs IVFFlat tradeoffs
type: reference
```

## Multi-Line Values

For long descriptions, use a literal block scalar (`|`) or folded block scalar (`>`):

```yaml
description: |
  A detailed description that spans
  multiple lines. Newlines are preserved.

description: >
  A description that wraps across
  lines. Newlines become spaces.
```

Prefer single-line descriptions for the `description` field. Use the body section for
multi-line content.

## Common Gotchas

**Tabs:** YAML does not allow tab characters for indentation. Only spaces. Most text
editors insert tabs by default in certain modes; configure your editor to use spaces
in YAML files.

**Trailing colons:** A line ending in `:` with nothing after it creates an empty value
(null), not a string. `name:` is valid (null name); `name: ` (trailing space) also
produces null.

**Number coercion:** `type: 1.5` parses as float, not string. Always quote values
that look numeric but are meant to be strings.

**Duplicate keys:** YAML permits duplicate keys; most parsers silently take the last
value. This is almost always a bug. Validate that each key appears once.

**The `---` marker:** Must be on its own line with no leading spaces. A frontmatter
block preceded by any whitespace will not be recognized as frontmatter.

## Parsing Test

A quick Node.js check to validate a frontmatter block:

```js
const matter = require('gray-matter');
const fs     = require('fs');

const { data, content } = matter(fs.readFileSync('entry.md', 'utf8'));

const required = ['name', 'description', 'type'];
const valid    = ['project', 'feedback', 'reference', 'user'];

for (const field of required) {
  if (!data[field]) throw new Error(`Missing required field: ${field}`);
}
if (!valid.includes(data.type)) {
  throw new Error(`Invalid type: ${data.type}. Must be one of: ${valid.join(', ')}`);
}
```
