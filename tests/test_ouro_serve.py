import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock
import pytest


class TestOuroServe:
    """Test cases for OuroServe leaderboard persistence and response headers."""
    
    @pytest.fixture
    def temp_leaderboard(self):
        """Create a temporary leaderboard file for testing."""
        with tempfile.TemporaryDirectory() as tmpdir:
            leaderboard_path = Path(tmpdir) / "data" / "eval" / "leaderboard.jsonl"
            yield leaderboard_path
    
    def test_leaderboard_receives_deep_mode_metrics(self, temp_leaderboard):
        """
        Test that leaderboard.jsonl receives mean_depth and mean_contraction 
        records after DEEP-mode request.
        """
        from ouro_serve import OuroServe
        
        # Create OuroServe instance with temp leaderboard path
        serve = OuroServe()
        serve.leaderboard_path = temp_leaderboard
        
        # Mock _loop_generate to return DEEP-mode metrics
        mock_result = {
            'text': 'Generated response',
            'mean_depth': 3.5,
            'mean_contraction': 0.75,
            'exit_reason': 'max_depth',
            'tokens': 150,
            'q': 'test prompt',
        }
        
        with patch.object(serve, '_loop_generate', return_value=mock_result):
            response, headers = serve._generate('test prompt', mode='DEEP')
        
        # Verify leaderboard file was created and contains the record
        assert temp_leaderboard.exists(), "Leaderboard file should be created"
        
        with open(temp_leaderboard, 'r') as f:
            lines = f.readlines()
        
        assert len(lines) == 1, "Should have one record in leaderboard"
        
        record = json.loads(lines[0])
        assert record['mode'] == 'DEEP', "Mode should be DEEP"
        assert record['mean_depth'] == 3.5, "mean_depth should be 3.5"
        assert record['mean_contraction'] == 0.75, "mean_contraction should be 0.75"
        assert record['exit_reason'] == 'max_depth', "exit_reason should be max_depth"
        assert record['tokens'] == 150, "tokens should be 150"
        assert record['q'] == 'test prompt', "q should contain the prompt"
        assert 'ts' in record, "Record should have timestamp"
    
    def test_response_header_x_ouro_depth(self, temp_leaderboard):
        """
        Test that x-ouro-depth response header is present and matches 
        mean_depth from leaderboard record.
        """
        from ouro_serve import OuroServe
        
        # Create OuroServe instance with temp leaderboard path
        serve = OuroServe()
        serve.leaderboard_path = temp_leaderboard
        
        # Mock _loop_generate to return specific mean_depth
        mock_result = {
            'text': 'Generated response',
            'mean_depth': 2.75,
            'mean_contraction': 0.82,
            'exit_reason': 'converged',
            'tokens': 120,
            'q': 'test prompt',
        }
        
        with patch.object(serve, '_loop_generate', return_value=mock_result):
            response, headers = serve._generate('test prompt', mode='DEEP')
        
        # Verify x-ouro-depth header is present and correct
        assert 'x-ouro-depth' in headers, "x-ouro-depth header should be present"
        assert headers['x-ouro-depth'] == '2.75', "x-ouro-depth should match mean_depth"
        
        # Verify leaderboard record matches header value
        with open(temp_leaderboard, 'r') as f:
            record = json.loads(f.readline())
        
        assert record['mean_depth'] == 2.75, "Leaderboard mean_depth should match header"
import json