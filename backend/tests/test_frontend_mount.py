"""Serving the built bundle, which the container carried and never served.

The image copied `frontend/dist` in, the compose file said the gateway served
it, and the gateway had no static mount at all — so anyone following the
documented `docker compose up` got a working API behind a 404. These tests are
here so that cannot come back quietly.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import create_app


def point_at(monkeypatch, directory: Path) -> None:
    """Aim the gateway at a bundle directory.

    Settings are a frozen dataclass resolved once at import, so this replaces
    the object the module holds rather than mutating the one it was given.
    """
    monkeypatch.setattr("app.main.settings", replace(settings, frontend_dist=directory))


@pytest.fixture
def bundle(tmp_path, monkeypatch) -> Path:
    """A minimal build output, shaped like the real one."""
    directory = tmp_path / "dist"
    (directory / "assets").mkdir(parents=True)
    (directory / "index.html").write_text(
        "<!doctype html><title>CodeCraft Studio</title><div id=root></div>"
    )
    (directory / "assets" / "index-abc123.js").write_text("console.log(1)")
    (directory / "favicon.svg").write_text("<svg/>")
    point_at(monkeypatch, directory)
    return directory


def test_the_page_is_served_at_the_root(bundle) -> None:
    with TestClient(create_app()) as client:
        response = client.get("/")
    assert response.status_code == 200
    assert "CodeCraft Studio" in response.text


def test_assets_are_served(bundle) -> None:
    with TestClient(create_app()) as client:
        response = client.get("/assets/index-abc123.js")
    assert response.status_code == 200
    assert "console.log" in response.text


def test_a_file_in_the_bundle_is_served(bundle) -> None:
    with TestClient(create_app()) as client:
        assert client.get("/favicon.svg").status_code == 200


def test_a_client_route_falls_back_to_the_page(bundle) -> None:
    """The router in the page owns these, and a reload must not 404."""
    with TestClient(create_app()) as client:
        response = client.get("/settings")
    assert response.status_code == 200
    assert "CodeCraft Studio" in response.text


def test_the_api_keeps_its_own_paths(bundle) -> None:
    with TestClient(create_app()) as client:
        assert client.get("/api/v1/health").status_code == 200


def test_an_unknown_api_path_is_still_a_404(bundle) -> None:
    """A catch-all that answers everything turns a typo into a parse error.

    Without this, a client calling an endpoint that does not exist gets a page
    of HTML and a 200, and finds out somewhere else entirely.
    """
    with TestClient(create_app()) as client:
        response = client.get("/api/v1/nope")
    assert response.status_code == 404
    assert "no such endpoint" in response.json()["detail"]


def test_a_path_cannot_climb_out_of_the_bundle(bundle, tmp_path) -> None:
    secret = tmp_path / "secret.txt"
    secret.write_text("not for serving")

    with TestClient(create_app()) as client:
        response = client.get("/../secret.txt")

    # Either refused or answered with the page; never the file itself.
    assert "not for serving" not in response.text


def test_no_bundle_means_no_mount(tmp_path, monkeypatch) -> None:
    """A development machine runs Vite on its own port and has no `dist`.

    Mounting a directory that is not there raises at import, so the absence has
    to be the normal case rather than an error.
    """
    point_at(monkeypatch, tmp_path / "nothing-here")
    with TestClient(create_app()) as client:
        assert client.get("/api/v1/health").status_code == 200
        assert client.get("/").status_code == 404


def test_a_directory_without_an_index_is_not_mounted(tmp_path, monkeypatch) -> None:
    """Half a build is not a build."""
    directory = tmp_path / "dist"
    directory.mkdir()
    point_at(monkeypatch, directory)
    with TestClient(create_app()) as client:
        assert client.get("/").status_code == 404
