"""Tests for the CSF-native Three Doors game loop.

Covers: StatusCube persistence, 7-stage routing, loop tracking,
consolidation into crystallized symbols, file-size constraint,
and door personalization.
"""

import random
import sys
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src")) # #1268

from csf.status_cube import StatusCube, NUM_STAGES
from three_doors_engine import ThreeDoorsEngine, STAGES, SCENES, personalize_doors


@pytest.fixture
def tmp_data_dir():
    with tempfile.TemporaryDirectory() as d:
        yield Path(d)


def test_stages_cover_seven_scenes():
    assert len(STAGES) == NUM_STAGES == 7
    for key in STAGES:
        assert key in SCENES, f"stage scene missing: {key}"
        assert len(SCENES[key]["doors"]) == 3


def test_new_game_starts_at_garden(tmp_data_dir):
    e = ThreeDoorsEngine("player-1", tmp_data_dir)
    state = e.start_game()
    assert state["scene_key"] == "kingdome-garden"
    assert state["stage_index"] == 0
    assert state["loop_count"] == 0


def test_full_loop_advances_and_wraps(tmp_data_dir):
    e = ThreeDoorsEngine("player-2", tmp_data_dir)
    e.start_game()
    for expected_stage in range(1, 7):
        state = e.choose_door("A")
        assert state["stage_index"] == expected_stage
        assert state["scene_key"] == STAGES[expected_stage]
        assert not state["loop_completed"]
    state = e.choose_door("A")
    assert state["loop_completed"]
    assert state["stage_index"] == 0
    assert state["loop_count"] == 1
    assert state["scene_key"] == "kingdome-garden"


def test_state_persists_across_engine_instances(tmp_data_dir):
    e = ThreeDoorsEngine("player-3", tmp_data_dir)
    e.start_game()
    e.choose_door("B")
    e.choose_door("C")

    e2 = ThreeDoorsEngine("player-3", tmp_data_dir)
    state = e2.load()
    assert state is not None
    assert state["stage_index"] == 2
    assert state["scene_key"] == STAGES[2]


def test_consolidation_creates_symbols(tmp_data_dir):
    e = ThreeDoorsEngine("player-4", tmp_data_dir)
    e.agent = "xenon"
    e.start_game()
    for _ in range(7):
        e.choose_door("A")
    assert e.cube.loop_count == 1
    assert e.cube.symbols, "loop completion should crystallize symbols"
    assert e.cube.observations == [], "observations should be pruned after consolidation"
    assert any(k.endswith("-walker") for k in e.cube.symbols)
    assert "xenon-companion" in e.cube.symbols


def test_file_stays_small_after_many_loops(tmp_data_dir):
    e = ThreeDoorsEngine("player-5", tmp_data_dir)
    e.start_game()
    random.seed(7)
    for _ in range(50 * 7):
        e.choose_door(random.choice("ABC"))
    size = e.cube._path().stat().st_size
    assert e.cube.loop_count == 50
    assert size < 10_240, f"CSF file too large after 50 loops: {size} bytes"


def test_invalid_choice_returns_none(tmp_data_dir):
    e = ThreeDoorsEngine("player-6", tmp_data_dir)
    e.start_game()
    assert e.choose_door("Z") is None
    assert e.choose_door("not a door") is None


def test_reset_discards_cube(tmp_data_dir):
    e = ThreeDoorsEngine("player-7", tmp_data_dir)
    e.start_game()
    for _ in range(10):
        e.choose_door("A")
    state = e.reset()
    assert state["stage_index"] == 0
    assert state["loop_count"] == 0
    assert e.cube.symbols == {}


def test_personalize_doors_marks_resonance():
    doors = SCENES["kingdome-garden"]["doors"]
    symbols = {"affinity-the-storybook-door": {"strength": 0.6}}
    out = personalize_doors(doors, "seeker", "lantern", symbols)
    assert len(out) == 3
    storybook = next(d for d in out if d["name"] == "The Storybook Door")
    assert storybook.get("resonance")
    assert "remembers you" in storybook["description"]
    # base doors must not be mutated
    assert "remembers you" not in doors[0]["description"]


def test_api_response_includes_journey_metadata(tmp_data_dir):
    e = ThreeDoorsEngine("player-8", tmp_data_dir)
    e.start_game()
    resp = e.to_api_response()
    for key in ("stage_index", "stage_count", "loop_count", "archetype",
                "symbols", "scene_key", "doors", "image_prompt"):
        assert key in resp, f"api response missing {key}"
    assert resp["stage_count"] == 7


def test_corrupt_cube_file_starts_fresh(tmp_data_dir):
    cube = StatusCube("player-9", tmp_data_dir)
    path = cube._path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"not a csf file at all")
    loaded = StatusCube.load("player-9", tmp_data_dir)
    assert loaded.stage_index == 0
    assert loaded.loop_count == 0
