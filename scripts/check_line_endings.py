#!/usr/bin/env python3
"""No carriage returns in files a Linux kernel has to execute.

A shebang line ending in \r makes the kernel look for an interpreter literally
named `bash\r`, and the container exits 127 with a message that names neither
the file nor the cause:

    /usr/bin/env: 'bash\r': No such file or directory

`.gitattributes` prevents it on checkout and the Dockerfile strips it during
the build, but neither helps if a CRLF file is ever committed — so this checks
the committed bytes, which is the one place the problem can actually start.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

#: Suffixes and names that are executed, or are whitespace-sensitive enough
#: that a stray \r changes their meaning.
MUST_BE_LF = (".sh", ".py", ".cfg", ".policy", ".mk")
NAMED = {"Makefile", "Dockerfile", "docker-entrypoint.sh", ".dockerignore"}


def tracked() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True
    )
    return [ROOT / name for name in result.stdout.decode().split("\0") if name]


def main() -> int:
    guilty: list[tuple[Path, int]] = []

    for path in tracked():
        if path.suffix not in MUST_BE_LF and path.name not in NAMED:
            continue
        try:
            body = path.read_bytes()
        except OSError:
            continue
        if b"\r" not in body:
            continue
        first = body.split(b"\n")[0]
        guilty.append((path.relative_to(ROOT), 1 if b"\r" in first else 0))

    if guilty:
        print("error: carriage returns in files that are executed on Linux:\n", file=sys.stderr)
        for path, in_shebang in guilty:
            note = "  <- in the shebang, so this one will not start at all" if in_shebang else ""
            print(f"  {path}{note}", file=sys.stderr)
        print(
            "\n  Fix with:  sed -i 's/\\r$//' <file>\n"
            "  And check .gitattributes covers the suffix, so it cannot recur.",
            file=sys.stderr,
        )
        return 1

    print(f"line endings ok: no carriage returns in {len(MUST_BE_LF)} executed file types")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
