"""Shared fixtures.

Tests exercise the real sandbox rather than a mock: the isolation behaviour is
the product, so stubbing it out would test nothing that matters.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.main import create_app  # noqa: E402
from app.runtimes import registry  # noqa: E402


@pytest.fixture
def app():
    return create_app()


@pytest.fixture
def client(app):
    from fastapi.testclient import TestClient

    with TestClient(app) as test_client:
        yield test_client


def installed(language: str) -> bool:
    runtime = registry().get(language)
    return bool(runtime and runtime.installed)


requires_python = pytest.mark.skipif(
    not installed("python"), reason="python3 toolchain is not installed"
)
