"""Taking a docstring back out, so restoring it can be the instruction.

The most useful examples here are the ones where a person wrote both halves:
a function, and the sentence explaining it. Removing the sentence turns that
pair into "document this", with an answer somebody already reviewed.

Only the simple shape is handled — a triple-quoted string as the function's
first statement. A partial removal would produce code that does not parse, and
teaching a model broken code is worse than teaching it nothing, so anything
unusual returns nothing at all and the example is skipped.
"""

from __future__ import annotations


def strip_docstring(body: str) -> str:
    """The same function without its docstring, or "" if it cannot be done."""
    lines = body.splitlines()
    quotes = ('"""', "'''")
    opened = None
    closing = ""

    for index, line in enumerate(lines):
        stripped = line.strip()
        if opened is None:
            if stripped.startswith(quotes):
                closing = stripped[:3]
                opened = index
                if len(stripped) > 3 and stripped.endswith(closing):
                    return "\n".join(lines[:index] + lines[index + 1 :])
            elif stripped.startswith(("def ", "async def ", "@")) or not stripped:
                continue
            elif stripped.endswith((",", "(", ":", ")")):
                continue
            else:
                # Code before any docstring: there is nothing to remove.
                return ""
        elif stripped.endswith(closing):
            return "\n".join(lines[:opened] + lines[index + 1 :])

    return ""

