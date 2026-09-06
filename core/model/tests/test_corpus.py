"""Fetching a corpus larger than the disk it is built on."""

from __future__ import annotations

import subprocess

import pytest

from codecraft_model.corpus import (
    Repository,
    clone,
    directory_size,
    estimate,
    iter_repository_sources,
    parse_repository,
    read_repository_list,
)


# ------------------------------------------------------------------- parsing


def test_owner_name_becomes_a_github_url() -> None:
    repository = parse_repository("torvalds/linux")
    assert repository.url == "https://github.com/torvalds/linux.git"
    assert repository.name == "torvalds/linux"


def test_a_full_url_is_taken_as_given() -> None:
    """So a corpus is not limited to one host."""
    repository = parse_repository("https://gitlab.com/group/project.git")
    assert repository.url == "https://gitlab.com/group/project.git"
    assert repository.name == "group/project"


def test_a_trailing_slash_is_ignored() -> None:
    assert parse_repository("owner/name/").name == "owner/name"


def test_the_directory_name_has_no_separator() -> None:
    """It becomes a single directory under the workspace."""
    assert "/" not in parse_repository("owner/name").directory_name


@pytest.mark.parametrize("spec", ["", "   ", "just-a-name", "too/many/slashes/here"])
def test_unusable_specifications_are_refused(spec: str) -> None:
    with pytest.raises(ValueError):
        parse_repository(spec)


def test_a_list_file_ignores_comments_and_blanks(tmp_path) -> None:
    path = tmp_path / "repos.txt"
    path.write_text(
        "# a comment\n"
        "\n"
        "torvalds/linux\n"
        "python/cpython  # trailing comment\n"
        "   \n"
        "rust-lang/rust\n"
    )
    assert [r.name for r in read_repository_list(path)] == [
        "torvalds/linux",
        "python/cpython",
        "rust-lang/rust",
    ]


# ------------------------------------------------------------------- cloning


@pytest.fixture
def local_repository(tmp_path):
    """A real git repository on disk, so cloning is exercised for real."""
    origin = tmp_path / "origin"
    (origin / "src").mkdir(parents=True)
    (origin / "src" / "main.py").write_text("def main():\n" + "    pass\n" * 30)
    (origin / "src" / "lib.rs").write_text("fn main() {\n" + "    let x = 1;\n" * 30 + "}\n")
    (origin / "README.md").write_text("# A project\n" * 30)

    for command in (
        ["git", "init", "--quiet", "-b", "main"],
        ["git", "add", "-A"],
        ["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "commit", "--quiet", "-m", "x"],
    ):
        subprocess.run(command, cwd=origin, check=True, capture_output=True)

    return origin


def test_cloning_produces_a_working_tree(local_repository, tmp_path) -> None:
    repository = Repository(str(local_repository), "local/project")
    checkout = clone(repository, tmp_path / "work")

    assert checkout is not None
    assert (checkout / "src" / "main.py").exists()


def test_the_git_directory_is_removed_after_cloning(local_repository, tmp_path) -> None:
    """Pack files are a large share of a shallow clone and hold nothing readable."""
    checkout = clone(Repository(str(local_repository), "local/project"), tmp_path / "work")
    assert not (checkout / ".git").exists()


def test_a_repository_that_cannot_be_fetched_is_skipped(tmp_path) -> None:
    """One bad entry must not lose a corpus built from fifty."""
    missing = Repository(str(tmp_path / "nothing-here"), "no/such")
    assert clone(missing, tmp_path / "work", timeout=30) is None


def test_a_failed_clone_leaves_nothing_behind(tmp_path) -> None:
    clone(Repository(str(tmp_path / "nope"), "no/such"), tmp_path / "work", timeout=30)
    assert not (tmp_path / "work" / "no_such").exists()


# ----------------------------------------------------------------- streaming


def test_sources_are_read_from_a_cloned_repository(local_repository, tmp_path) -> None:
    repositories = [Repository(str(local_repository), "local/project")]
    names = {
        path.rsplit("/", 1)[-1]
        for path, _ in iter_repository_sources(repositories, tmp_path / "work", progress=False)
    }
    assert {"main.py", "lib.rs", "README.md"} <= names


def test_each_repository_is_deleted_once_it_is_read(local_repository, tmp_path) -> None:
    """This is what keeps peak disk flat regardless of how long the list is."""
    workspace = tmp_path / "work"
    repositories = [Repository(str(local_repository), "local/project")]

    list(iter_repository_sources(repositories, workspace, progress=False))

    assert not any(workspace.iterdir())


def test_a_repository_is_deleted_even_when_reading_stops_early(
    local_repository, tmp_path
) -> None:
    """A generator abandoned mid-stream must not leave the disk full."""
    workspace = tmp_path / "work"
    repositories = [Repository(str(local_repository), "local/project")]

    stream = iter_repository_sources(repositories, workspace, progress=False)
    next(stream)
    stream.close()

    assert not any(workspace.iterdir())


def test_an_unreachable_repository_does_not_stop_the_rest(
    local_repository, tmp_path
) -> None:
    repositories = [
        Repository(str(tmp_path / "missing"), "no/such"),
        Repository(str(local_repository), "local/project"),
    ]
    produced = list(
        iter_repository_sources(repositories, tmp_path / "work", progress=False)
    )
    assert produced, "the reachable repository should still have been read"


def test_directory_size_counts_the_files(tmp_path) -> None:
    (tmp_path / "a.txt").write_text("x" * 100)
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "b.txt").write_text("y" * 50)
    assert directory_size(tmp_path) == 150


# ------------------------------------------------------------------ estimates


def test_a_billion_tokens_is_two_gigabytes_of_tokens() -> None:
    """uint16, so the arithmetic is exact rather than a rule of thumb."""
    assert estimate(1_000_000_000)["token_stream_gb"] == pytest.approx(2.0)


def test_the_source_is_far_larger_than_the_tokens() -> None:
    numbers = estimate(1_000_000_000)
    assert numbers["source_text_gb"] == pytest.approx(3.5)
    assert numbers["repositories_gb"] > numbers["source_text_gb"]


def test_streaming_costs_far_less_than_keeping_the_sources() -> None:
    """The whole reason clones are deleted as they are read."""
    numbers = estimate(1_000_000_000)
    assert numbers["peak_disk_streaming_gb"] < numbers["peak_disk_keeping_sources_gb"] / 4


def test_estimates_scale_linearly() -> None:
    small = estimate(1_000_000)
    large = estimate(1_000_000_000)
    assert large["token_stream_gb"] == pytest.approx(small["token_stream_gb"] * 1000)


def test_a_denser_tokenizer_needs_more_source_for_the_same_tokens() -> None:
    assert estimate(1_000_000, 5.0)["source_text_gb"] > estimate(1_000_000, 3.5)["source_text_gb"]
