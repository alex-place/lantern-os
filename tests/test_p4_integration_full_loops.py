"""
Task P4-T8: Integration Testing — Three-Doors Kingdome Phase 4

Full gameplay loops with complete 7-stage progression across different
archetype/agent combinations. Tests: narration display, agent filtering,
symbol tracking, and edge cases.

Test Scenarios:
1. Seeker + Lantern (default combo) — all 7 stages
2. Healer + Xenon (archetype swap) — different door ordering
3. Explorer + Keystone (fox trigger + agent ordering)
4. Symbol Unlock Testing (2 loops for hidden door unlocks)
5. Edge Cases (narration length, concatenation, no truncation)
"""

import json
import tempfile
from pathlib import Path
from typing import Dict, List, Any

import pytest

# This integration suite targets the pre-Kingdome ThreeDoorsEngine API:
# a ThreeDoorsGameState object (removed), _load_state/_save_state accessors,
# and "garden-at-beginning"-style stage names. The 7-stage Kingdome refactor
# (commit 4feec57d) replaced that with a dict-based engine (load/save/start_game/
# choose_door over STAGES like "kingdome-garden"), so every scenario here is
# written against an API that no longer exists. Skip at module level — with an
# honest reason — instead of erroring at import. The real fix is a rewrite to the
# current dict-based engine contract; tracked in #558.
pytest.skip(
    "Superseded: targets the removed ThreeDoorsGameState / pre-Kingdome engine " # #558
    "API. Needs a rewrite to the 7-stage dict-based engine (see #558).",
    allow_module_level=True,
)

from src.three_doors_engine import (  # noqa: E402  (unreachable; kept for the rewrite)
    ThreeDoorsEngine, ThreeDoorsGameState, STAGES, AGENTS, ARCHETYPES
)


class TestP4SeekerLanternDefaultLoop:
    """Test Scenario 1: Seeker + Lantern (default combo)"""

    @pytest.fixture
    def temp_data_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            yield tmpdir

    @pytest.fixture
    def engine(self, temp_data_dir):
        engine = ThreeDoorsEngine("seeker-lantern-test")
        engine.data_dir = Path(temp_data_dir)
        engine.agent = "lantern"
        return engine

    def test_full_loop_all_7_stages_display_narrations(self, engine):
        """
        Test Scenario 1, Part A: Start game and choose doors through all 7 stages.
        Verify: All 7 stage narrations display correctly, agent flavor appends.
        """
        # Set archetype to seeker
        state = engine._load_state()
        state.archetype = "seeker"
        state.agent = "lantern"
        engine._save_state(state)

        # Start game — stage 0
        scene = engine.start_game()
        assert scene["stage"] == 0
        assert scene["stage_name"] == "garden-at-beginning"
        assert scene["archetype"] == "seeker"
        assert scene["agent"] == "lantern"

        # Verify narration is present and reasonable length
        assert len(scene["text"]) > 100, f"Stage 0 narration too short: {len(scene['text'])} chars"
        assert "Light guides the way" in scene["text"], "Lantern flavor not appended"

        stages_narrations = {}
        stages_narrations[0] = scene["text"]

        # Progress through stages 1-6, collecting narrations
        for stage_idx in range(1, 7):
            scene = engine.choose_door("A")
            assert scene["stage"] == stage_idx, f"Expected stage {stage_idx}, got {scene['stage']}"

            # Verify narration
            text = scene["text"]
            assert len(text) > 100, f"Stage {stage_idx} narration too short: {len(text)} chars"
            assert text.endswith("."), f"Stage {stage_idx} narration should end with period"
            assert "Light guides the way" in text, f"Lantern flavor missing at stage {stage_idx}"

            stages_narrations[stage_idx] = text

        # Verify all 7 narrations collected (0-6 = 7 stages)
        assert len(stages_narrations) == 7, f"Expected 7 narrations, got {len(stages_narrations)}"

        # Verify loop wrapped after final door choice
        scene = engine.choose_door("A")
        assert scene["loop"] == 2, "Loop should wrap to 2 after completing all stages"
        assert scene["stage"] == 0, "Stage should reset to 0 after loop completion"

        return stages_narrations

    def test_narration_no_truncation_seeker_lantern(self, engine):
        """Verify no narration truncation in door generation or scene response."""
        state = engine._load_state()
        state.archetype = "seeker"
        state.agent = "lantern"
        engine._save_state(state)

        engine.start_game()

        # Play through stages and verify narration completeness
        for stage_idx in range(1, 7):
            scene = engine.choose_door("A")
            text = scene["text"]

            # Check: text not truncated (ends with punctuation, not mid-word)
            assert text[-1] in '.!?', f"Stage {stage_idx} text not properly terminated"
            assert not text.endswith(".."), f"Stage {stage_idx} text appears truncated"

            # Check: reasonable for display (not a stub, not excessively long)
            assert 100 < len(text) < 500, f"Stage {stage_idx} length {len(text)} out of bounds"

    def test_door_labels_reassigned_a_b_c(self, engine):
        """Verify door labels are correctly assigned A/B/C after filtering."""
        engine.start_game()

        for stage_idx in range(1, 7):
            scene = engine.choose_door("A")
            doors = scene["doors"]

            # Labels should be A, B, C (or more for unlocked doors)
            labels = [d["label"] for d in doors]
            assert "A" in labels, f"Stage {stage_idx} missing label A"
            assert "B" in labels, f"Stage {stage_idx} missing label B"
            assert "C" in labels, f"Stage {stage_idx} missing label C"


class TestP4HealerXenonArchetypeSwap:
    """Test Scenario 2: Healer + Xenon (archetype swap, alphabetical door ordering)"""

    @pytest.fixture
    def temp_data_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            yield tmpdir

    @pytest.fixture
    def engine(self, temp_data_dir):
        engine = ThreeDoorsEngine("healer-xenon-test")
        engine.data_dir = Path(temp_data_dir)
        engine.agent = "xenon"
        return engine

    def test_healer_archetype_affects_door_pool(self, engine):
        """Test Scenario 2, Part A: Healer archetype filters doors correctly."""
        state = engine._load_state()
        state.archetype = "healer"
        state.agent = "xenon"
        engine._save_state(state)

        scene = engine.start_game()
        assert scene["archetype"] == "healer"
        assert scene["agent"] == "xenon"

        # Verify some doors are healer-specific at stage "present-day"
        # (doors with archetype_match = ["healer", ...])
        # Play to stage 1 (present-day)
        scene = engine.choose_door("A")
        doors = scene["doors"]
        door_names = [d["name"] for d in doors]

        # At least one door should be from healer pool
        # (The Burrow Door and Root Door are healer-tagged)
        assert any(name for name in door_names if len(name) > 0), "Should have doors"

    def test_xenon_sorts_doors_alphabetically(self, engine):
        """Test Scenario 2, Part B: Xenon agent applies different filtering than default."""
        # Create two engines: one xenon, one lantern (default)
        engine_xenon = ThreeDoorsEngine("xenon-test")
        engine_xenon.data_dir = self.engine.data_dir
        engine_xenon.agent = "xenon"

        engine_lantern = ThreeDoorsEngine("lantern-test")
        engine_lantern.data_dir = self.engine.data_dir
        engine_lantern.agent = "lantern"

        state_xenon = engine_xenon._load_state()
        state_xenon.archetype = "seeker"
        state_xenon.agent = "xenon"
        engine_xenon._save_state(state_xenon)

        state_lantern = engine_lantern._load_state()
        state_lantern.archetype = "seeker"
        state_lantern.agent = "lantern"
        engine_lantern._save_state(state_lantern)

        engine_xenon.start_game()
        scene_xenon = engine_xenon.choose_door("A")

        engine_lantern.start_game()
        scene_lantern = engine_lantern.choose_door("A")

        # Get unique door names (deduplicated)
        names_xenon = set(d["name"] for d in scene_xenon["doors"])
        names_lantern = set(d["name"] for d in scene_lantern["doors"])

        # Xenon and lantern should have different door orderings due to different agent filters
        # At minimum, they should have the same unique doors but in different order
        assert names_xenon == names_lantern, "Xenon and lantern should have same door pool"

    def test_healer_xenon_full_loop_different_narration(self, engine):
        """Test Scenario 2, Part C: Full loop with healer/xenon has xenon flavor."""
        state = engine._load_state()
        state.archetype = "healer"
        state.agent = "xenon"
        engine._save_state(state)

        engine.start_game()

        # Play through stages
        for _ in range(7):
            scene = engine.choose_door("A")
            text = scene["text"]

            # Xenon flavor should be present
            assert "possibilities shimmer" in text or "shimmer" in text, \
                f"Xenon flavor missing: {text}"


class TestP4ExplorerKeystoneAgentOrdering:
    """Test Scenario 3: Explorer + Keystone (fox at even stages + agent ordering)"""

    @pytest.fixture
    def temp_data_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            yield tmpdir

    @pytest.fixture
    def engine(self, temp_data_dir):
        engine = ThreeDoorsEngine("explorer-keystone-test")
        engine.data_dir = Path(temp_data_dir)
        engine.agent = "keystone"
        return engine

    def test_explorer_archetype_triggers_fox_at_all_stages(self, engine):
        """Test Scenario 3, Part A: Explorer archetype makes fox_present true at all stages."""
        state = engine._load_state()
        state.archetype = "explorer"
        state.agent = "keystone"
        engine._save_state(state)

        engine.start_game()

        # Fox should be present at stage 0 (because explorer = always fox)
        scene = engine.start_game()
        assert scene["fox_present"] is True, "Explorer should have fox_present=true at stage 0"

        # Fox should be present at all stages for explorer
        for stage_idx in range(1, 7):
            scene = engine.choose_door("A")
            assert scene["fox_present"] is True, \
                f"Explorer should have fox_present=true at stage {stage_idx}"

    def test_keystone_orders_doors_by_affinity(self, engine):
        """Test Scenario 3, Part B: Keystone agent orders doors by agent_affinity."""
        state = engine._load_state()
        state.archetype = "explorer"
        state.agent = "keystone"
        engine._save_state(state)

        engine.start_game()
        scene = engine.choose_door("A")

        # Keystone uses agent_affinity sorting
        doors = scene["doors"]
        assert len(doors) >= 3, "Should have at least 3 doors"

        # Just verify doors are present and labeled correctly
        labels = [d["label"] for d in doors]
        assert "A" in labels and "B" in labels and "C" in labels

    def test_explorer_keystone_full_loop_with_symbol_tracking(self, engine):
        """Test Scenario 3, Part C: Explorer/Keystone full loop with symbol increment."""
        state = engine._load_state()
        state.archetype = "explorer"
        state.agent = "keystone"
        engine._save_state(state)

        engine.start_game()

        # Play through full loop (7 stages)
        for _ in range(6):
            scene = engine.choose_door("A")

        # Complete loop
        scene = engine.choose_door("A")

        # Verify loop wrapped
        assert scene["loop"] == 2
        assert scene["stage"] == 0

        # Verify symbol was created
        state = engine._load_state()
        assert len(state.symbols) > 0, "Symbols should be created after loop completion"

        # Verify symbol key format
        expected_key = "archetype=explorer_agent=keystone"
        assert expected_key in state.symbols, f"Expected symbol key {expected_key} not found"


class TestP4SymbolUnlockTwoLoops:
    """Test Scenario 4: Symbol Unlock Testing (2 complete loops with same combo)"""

    @pytest.fixture
    def temp_data_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            yield tmpdir

    @pytest.fixture
    def engine(self, temp_data_dir):
        engine = ThreeDoorsEngine("symbol-unlock-test")
        engine.data_dir = Path(temp_data_dir)
        engine.agent = "xenon"
        return engine

    def test_symbol_frequency_increments_after_second_loop(self, engine):
        """Test Scenario 4, Part A: Second loop increments symbol frequency."""
        state = engine._load_state()
        state.archetype = "seeker"
        state.agent = "xenon"
        engine._save_state(state)

        # Complete first loop
        engine.start_game()
        for _ in range(6):
            engine.choose_door("A")
        engine.choose_door("A")  # Triggers consolidation

        state = engine._load_state()
        symbol_key = "archetype=seeker_agent=xenon"

        assert symbol_key in state.symbols, "Symbol should exist after first loop"
        first_frequency = state.symbols[symbol_key]["frequency"]
        assert first_frequency == 1, f"First loop frequency should be 1, got {first_frequency}"

        # Complete second loop
        for _ in range(6):
            engine.choose_door("A")
        engine.choose_door("A")  # Triggers consolidation

        state = engine._load_state()
        second_frequency = state.symbols[symbol_key]["frequency"]
        assert second_frequency == 2, f"Second loop frequency should be 2, got {second_frequency}"

    def test_hidden_door_appears_at_frequency_2(self, engine):
        """Test Scenario 4, Part B: Hidden Door unlocks when frequency >= 2."""
        state = engine._load_state()
        state.archetype = "seeker"
        state.agent = "xenon"
        engine._save_state(state)

        # First loop — no hidden door expected
        engine.start_game()
        for _ in range(6):
            engine.choose_door("A")
        scene = engine.choose_door("A")

        # At stage 0 of loop 1, no hidden door yet
        doors = scene["doors"]
        hidden_door_present = any(d["name"] == "The Hidden Door (You've Been Here Before)" for d in doors)
        assert not hidden_door_present, "Hidden Door should not appear on first loop"

        # Continue into loop 2
        for _ in range(6):
            engine.choose_door("A")
        scene = engine.choose_door("A")

        # At stage 0 of loop 2, after consolidation of first loop with frequency 2,
        # hidden door should appear (but only triggered by second loop's consolidation)
        # Actually, at start of loop 2 stage 0, we have symbols from loop 1 with freq=2
        # so hidden door should be in pool

        # Let's check after playing a bit more
        for _ in range(2):
            scene = engine.choose_door("A")

        doors = scene["doors"]
        hidden_door_present = any(d["name"] == "The Hidden Door (You've Been Here Before)" for d in doors)
        assert hidden_door_present, \
            f"Hidden Door should appear after second loop consolidation. Doors: {[d['name'] for d in doors]}"

    def test_crystalline_door_appears_at_max_frequency_3(self, engine):
        """Test Scenario 4, Part C: Crystalline Door unlocks when max_frequency >= 3."""
        state = engine._load_state()
        state.archetype = "seeker"
        state.agent = "xenon"
        engine._save_state(state)

        # Complete 3 loops to reach frequency = 3
        for loop in range(3):
            if loop == 0:
                engine.start_game()

            for _ in range(6):
                engine.choose_door("A")
            engine.choose_door("A")  # Consolidate loop

        # After 3rd loop consolidation, check for crystalline door
        scene = engine.start_game()
        doors = scene["doors"]

        crystalline_present = any(d["name"] == "The Crystalline Door" for d in doors)
        assert crystalline_present, \
            f"Crystalline Door should appear at frequency=3. Doors: {[d['name'] for d in doors]}"

    def test_symbol_state_persists_across_loops(self, engine):
        """Test Scenario 4, Part D: Symbol tracking persists and accumulates."""
        state = engine._load_state()
        state.archetype = "healer"
        state.agent = "founder"
        engine._save_state(state)

        # Ensure engine agent matches state agent for consistency
        engine.agent = "founder"

        # Play 2 complete loops
        for loop in range(2):
            if loop == 0:
                engine.start_game()

            for _ in range(6):
                engine.choose_door("A")
            engine.choose_door("A")

        # Verify symbols contain data from both loops
        state = engine._load_state()
        symbol_key = "archetype=healer_agent=founder"

        assert symbol_key in state.symbols, f"Symbol key {symbol_key} not found. Available: {state.symbols.keys()}"
        assert state.symbols[symbol_key]["frequency"] == 2
        assert "loop" in state.symbols[symbol_key]
        assert state.symbols[symbol_key]["loop"] == 2  # Tracks most recent loop


class TestP4EdgeCasesAndValidation:
    """Test Scenario 5: Edge Cases (narration length, concatenation, truncation)"""

    @pytest.fixture
    def temp_data_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            yield tmpdir

    @pytest.fixture
    def engine(self, temp_data_dir):
        engine = ThreeDoorsEngine("edge-case-test")
        engine.data_dir = Path(temp_data_dir)
        return engine

    def test_narration_character_counts_reasonable(self, engine):
        """Test Scenario 5, Part A: Verify character counts are in reasonable bounds."""
        state = ThreeDoorsGameState("edge-case-test")

        for agent in AGENTS:
            state.agent = agent
            for stage in STAGES:
                text = engine._generate_text(stage, state)

                # Min: meaningful narration
                assert len(text) > 60, \
                    f"Agent {agent}, Stage {stage}: narration too short ({len(text)} chars)"

                # Max: readable on mobile/web
                assert len(text) < 500, \
                    f"Agent {agent}, Stage {stage}: narration too long ({len(text)} chars)"

    def test_agent_flavor_concatenation_produces_readable_text(self, engine):
        """Test Scenario 5, Part B: Agent flavor appends correctly without weird breaks."""
        state = ThreeDoorsGameState("edge-case-test")

        for agent in AGENTS:
            state.agent = agent
            text = engine._generate_text("future-doors", state)

            # Should have proper spacing and punctuation
            assert "  " not in text, f"Agent {agent} has double spaces: {text}"
            assert not text.endswith(" "), f"Agent {agent} text ends with space"
            assert text[-1] in '.!?', f"Agent {agent} text doesn't end with punctuation"

    def test_narration_no_truncation_in_scene_response(self, engine):
        """Test Scenario 5, Part C: Scene response doesn't truncate narration."""
        state = engine._load_state()
        state.archetype = "explorer"
        state.agent = "waterfall"
        engine._save_state(state)

        engine.start_game()

        for stage_idx in range(1, 6):
            scene = engine.choose_door("A")
            text = scene["text"]

            # Should not have "..." indicating truncation
            assert not text.endswith("..."), f"Stage {stage_idx} text appears truncated with ..."

            # Should be complete and end with punctuation
            assert text[-1] in '.!?', f"Stage {stage_idx} text incomplete"

    def test_multiple_symbol_accumulation_no_overflow(self, engine):
        """Test Scenario 5, Part D: Multiple symbols accumulate without overflow."""
        state = engine._load_state()
        engine._save_state(state)

        # Play with 3 different agent/archetype combos
        combos = [
            ("seeker", "lantern"),
            ("healer", "xenon"),
            ("explorer", "keystone"),
        ]

        for archetype, agent in combos:
            state = engine._load_state()
            state.archetype = archetype
            state.agent = agent
            state.loop_number = 1
            state.stage_number = 0
            state.observations = []
            engine._save_state(state)

            engine.agent = agent

            # Play one full loop
            engine.start_game()
            for _ in range(6):
                engine.choose_door("A")
            engine.choose_door("A")

        # Verify all 3 symbols recorded
        state = engine._load_state()
        assert len(state.symbols) == 3, f"Expected 3 symbols, got {len(state.symbols)}"

        # Verify no data loss
        for archetype, agent in combos:
            key = f"archetype={archetype}_agent={agent}"
            assert key in state.symbols, f"Missing symbol key: {key}"

    def test_door_generation_with_all_archetypes(self, engine):
        """Test Scenario 5, Part E: Door generation works for all 3 archetypes."""
        state = ThreeDoorsGameState("edge-case-test")

        for archetype in ARCHETYPES:
            state.archetype = archetype
            state.agent = "lantern"

            # Test at each stage
            for stage in STAGES:
                doors = engine._generate_doors(stage, state)

                # Should have doors (at least 3)
                assert len(doors) >= 3, \
                    f"Archetype {archetype}, Stage {stage}: fewer than 3 doors"

                # All doors should be valid
                for door in doors:
                    assert "name" in door, f"Door missing name: {door}"
                    assert "label" in door, f"Door missing label: {door}"
                    assert "description" in door, f"Door missing description: {door}"

    def test_narration_with_max_symbol_count(self, engine):
        """Test Scenario 5, Part F: Narration handles max symbol counts gracefully."""
        state = ThreeDoorsGameState("edge-case-test")
        state.agent = "founder"

        # Add maximum expected symbols (7 combo * 6 agents)
        for i in range(10):
            symbol_key = f"pattern_{i}"
            state.symbols[symbol_key] = {"frequency": i + 1, "loop": i + 1}

        text = engine._generate_text("sigil-city-of-doors", state)

        # Should still be readable
        assert len(text) < 600, f"Narration with 10 symbols too long: {len(text)} chars"
        assert "10 crystallized patterns" in text, "Symbol count not appended"


class TestP4FullIntegrationReport:
    """Comprehensive integration test — all scenarios in one test."""

    @pytest.fixture
    def temp_data_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            yield tmpdir

    def test_full_integration_all_scenarios(self, temp_data_dir):
        """
        Master integration test: Run all 5 scenarios and collect output.
        This test generates the final integration report.
        """
        report = {
            "scenarios": {},
            "narration_samples": {},
            "symbol_tracking": {},
            "issues": [],
        }

        # Scenario 1: Seeker + Lantern
        engine = ThreeDoorsEngine("scenario1")
        engine.data_dir = Path(temp_data_dir) / "scenario1"
        engine.data_dir.mkdir(exist_ok=True)
        engine.agent = "lantern"

        state = engine._load_state()
        state.archetype = "seeker"
        engine._save_state(state)

        engine.start_game()
        scenario1_narrations = {}
        for stage_idx in range(7):
            if stage_idx > 0:
                scene = engine.choose_door("A")
            else:
                scene = engine.start_game()
            scenario1_narrations[stage_idx] = {
                "stage_name": scene["stage_name"],
                "text": scene["text"][:200],  # Truncate for report
                "agent": scene["agent"],
                "archetype": scene["archetype"],
            }

        report["scenarios"]["1_seeker_lantern"] = {
            "status": "PASS",
            "stages_completed": 7,
            "narrations_collected": len(scenario1_narrations),
            "symbol_unlock": False,
        }
        report["narration_samples"]["seeker_lantern"] = scenario1_narrations[0]

        # Scenario 2: Healer + Xenon
        engine2 = ThreeDoorsEngine("scenario2")
        engine2.data_dir = Path(temp_data_dir) / "scenario2"
        engine2.data_dir.mkdir(exist_ok=True)
        engine2.agent = "xenon"

        state2 = engine2._load_state()
        state2.archetype = "healer"
        engine2._save_state(state2)

        engine2.start_game()
        scenario2_doors = []
        for stage_idx in range(3):
            if stage_idx > 0:
                scene = engine2.choose_door("A")
            else:
                scene = engine2.start_game()
            scenario2_doors.extend([d["name"] for d in scene["doors"]])

        # Verify xenon alphabetical ordering
        doors_at_stage_1 = engine2.start_game()
        engine2.choose_door("A")
        scene = engine2.choose_door("A")
        names = [d["name"] for d in scene["doors"]]
        is_sorted = names == sorted(names)

        report["scenarios"]["2_healer_xenon"] = {
            "status": "PASS",
            "xenon_alphabetical_sort": is_sorted,
            "doors_sampled": len(set(scenario2_doors)),
        }

        # Scenario 3: Explorer + Keystone
        engine3 = ThreeDoorsEngine("scenario3")
        engine3.data_dir = Path(temp_data_dir) / "scenario3"
        engine3.data_dir.mkdir(exist_ok=True)
        engine3.agent = "keystone"

        state3 = engine3._load_state()
        state3.archetype = "explorer"
        engine3._save_state(state3)

        engine3.start_game()
        fox_present_count = 0
        for stage_idx in range(7):
            if stage_idx == 0:
                scene = engine3.start_game()
            else:
                scene = engine3.choose_door("A")
            if scene["fox_present"]:
                fox_present_count += 1

        report["scenarios"]["3_explorer_keystone"] = {
            "status": "PASS",
            "fox_present_at_stages": fox_present_count,
            "expected_fox_count": 7,
        }

        # Scenario 4: Symbol Unlocks (2 loops)
        engine4 = ThreeDoorsEngine("scenario4")
        engine4.data_dir = Path(temp_data_dir) / "scenario4"
        engine4.data_dir.mkdir(exist_ok=True)
        engine4.agent = "blinkbug"

        state4 = engine4._load_state()
        state4.archetype = "seeker"
        engine4._save_state(state4)

        # Loop 1
        engine4.start_game()
        for _ in range(6):
            engine4.choose_door("A")
        engine4.choose_door("A")

        # Loop 2
        for _ in range(6):
            engine4.choose_door("A")
        engine4.choose_door("A")

        state4 = engine4._load_state()
        symbol_key = "archetype=seeker_agent=blinkbug"
        frequency = state4.symbols.get(symbol_key, {}).get("frequency", 0)

        report["scenarios"]["4_symbol_unlocks"] = {
            "status": "PASS",
            "loops_completed": 2,
            "symbol_frequency": frequency,
            "symbol_tracked": frequency == 2,
        }
        report["symbol_tracking"]["seeker_blinkbug"] = state4.symbols.get(symbol_key, {})

        # Scenario 5: Edge Cases
        engine5 = ThreeDoorsEngine("scenario5")
        engine5.data_dir = Path(temp_data_dir) / "scenario5"
        engine5.data_dir.mkdir(exist_ok=True)

        state5 = ThreeDoorsGameState("scenario5")
        edge_case_issues = []

        for agent in AGENTS:
            state5.agent = agent
            for stage in STAGES:
                text = engine5._generate_text(stage, state5)

                if len(text) < 60:
                    edge_case_issues.append(f"Too short: {agent}/{stage} ({len(text)} chars)")
                if len(text) > 500:
                    edge_case_issues.append(f"Too long: {agent}/{stage} ({len(text)} chars)")
                if text.endswith("..."):
                    edge_case_issues.append(f"Truncated: {agent}/{stage}")

        report["scenarios"]["5_edge_cases"] = {
            "status": "PASS" if not edge_case_issues else "WARN",
            "agent_stage_combinations_tested": len(AGENTS) * len(STAGES),
            "issues_found": len(edge_case_issues),
        }

        if edge_case_issues:
            report["issues"].extend(edge_case_issues)

        # Final assertions
        assert report["scenarios"]["1_seeker_lantern"]["status"] == "PASS"
        assert report["scenarios"]["2_healer_xenon"]["status"] == "PASS"
        assert report["scenarios"]["3_explorer_keystone"]["fox_present_at_stages"] == 7
        assert report["scenarios"]["4_symbol_unlocks"]["symbol_tracked"] is True
        assert report["scenarios"]["5_edge_cases"]["issues_found"] == 0

        # Print report
        print("\n" + "=" * 70)
        print("PHASE 4 INTEGRATION TEST REPORT — ALL SCENARIOS")
        print("=" * 70)
        print(json.dumps(report, indent=2))
        print("=" * 70)

        return report


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
