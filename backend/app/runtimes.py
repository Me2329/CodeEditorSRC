"""Runtime catalogue.

`scripts/runtimes.json` is the single source of truth shared by the Bash runner,
this gateway and the frontend. Loading it here rather than restating the list
keeps the three layers from drifting apart.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from .config import settings


@dataclass(frozen=True)
class Runtime:
    id: str
    label: str
    category: str
    monaco: str
    extension: str
    entry: str
    probe: str | None
    notes: str
    template: str
    executable: bool  # False for client-only runtimes such as HTML preview
    # Toolchains in preference order. Distributions disagree about names, so a
    # runtime is available when any one of them is present.
    candidate_probes: tuple[str, ...] = ()

    @property
    def resolved_toolchain(self) -> str | None:
        """The toolchain binary this host would actually use, if any."""
        if not self.executable:
            return None
        for probe in self.candidate_probes or ((self.probe,) if self.probe else ()):
            if probe and shutil.which(probe) is not None:
                return probe
        return None

    @property
    def installed(self) -> bool:
        """Whether this host can actually run the runtime."""
        return self.resolved_toolchain is not None


class RuntimeRegistry:
    def __init__(self, runtimes: dict[str, Runtime]) -> None:
        self._runtimes = runtimes

    def __contains__(self, runtime_id: object) -> bool:
        return runtime_id in self._runtimes

    def get(self, runtime_id: str) -> Runtime | None:
        return self._runtimes.get(runtime_id)

    def all(self) -> list[Runtime]:
        return list(self._runtimes.values())

    def executable_ids(self) -> set[str]:
        return {r.id for r in self._runtimes.values() if r.executable}


def _load(path: Path) -> RuntimeRegistry:
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)

    runtimes: dict[str, Runtime] = {}
    for runtime_id, entry in payload.get("runtimes", {}).items():
        runtimes[runtime_id] = Runtime(
            id=runtime_id,
            label=entry.get("label", runtime_id),
            category=entry.get("category", "other"),
            monaco=entry.get("monaco", "plaintext"),
            extension=entry.get("extension", "txt"),
            entry=entry.get("entry", "main.txt"),
            probe=entry.get("probe"),
            notes=entry.get("notes", ""),
            template=entry.get("template", ""),
            # A runtime with no run command is rendered client-side only.
            executable=bool(entry.get("run")),
            candidate_probes=tuple(
                candidate["probe"]
                for candidate in entry.get("candidates", [])
                if candidate.get("probe")
            ),
        )
    return RuntimeRegistry(runtimes)


@lru_cache(maxsize=1)
def registry() -> RuntimeRegistry:
    return _load(settings.runtimes_path)
