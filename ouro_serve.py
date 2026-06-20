import time
from pathlib import Path


def _append_leaderboard_entry(entry_dict):
    """Append a metrics entry to the leaderboard JSONL file."""
    leaderboard_path = Path("data/eval/leaderboard.jsonl")
    leaderboard_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(leaderboard_path, "a") as f:
        f.write(json.dumps(entry_dict) + "\n")


def _generate(prompt, **kwargs):
    """Generate response and persist DEEP-mode metrics to leaderboard."""
    # Call the loop generator and capture full dict
    full_result = _loop.generate(prompt, **kwargs)
    
    # Extract text for response
    text_output = full_result.get('text', '')
    
    # Extract metrics from result
    ts = int(time.time())
    mode = full_result.get('mode', 'default')
    mean_depth = full_result.get('mean_depth')
    exit_reason = full_result.get('exit_reason')
    tokens = full_result.get('tokens', 0)
    q = full_result.get('q')
    mean_contraction = full_result.get('mean_contraction')
    
    # Persist metrics to leaderboard if in DEEP mode
    if mode == 'converge' or mean_depth is not None:
        entry = {
            'ts': str(ts),
            'mode': mode,
            'mean_depth': mean_depth,
            'exit_reason': exit_reason,
            'tokens': tokens,
            'q': q,
            'mean_contraction': mean_contraction
        }
        _append_leaderboard_entry(entry)
    
    # Prepare response with metrics header
    response = {
        'text': text_output,
        'mode': mode,
        'mean_depth': mean_depth,
        'exit_reason': exit_reason,
        'tokens': tokens,
        'q': q,
        'mean_contraction': mean_contraction
    }
    
    # Set response header for client-side visualization
    if mean_depth is not None:
        response['headers'] = {
            'x-ouro-depth': str(mean_depth)
        }
    
    return response
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, Optional


class OuroServe:
    def __init__(self):
        self.leaderboard_path = Path("data/eval/leaderboard.jsonl")
        self._ensure_leaderboard_dir()
    
    def _ensure_leaderboard_dir(self):
        """Ensure data/eval/ directory exists."""
        self.leaderboard_path.parent.mkdir(parents=True, exist_ok=True)
    
    def _append_to_leaderboard(self, record: Dict[str, Any]):
        """Append a record to leaderboard.jsonl in JSONL format."""
        self._ensure_leaderboard_dir()
        with open(self.leaderboard_path, 'a') as f:
            f.write(json.dumps(record) + '\n')
    
    def _generate(self, prompt: str, mode: Optional[str] = None) -> tuple[Dict[str, Any], Dict[str, str]]:
        """
        Generate response using LoopLM.
        
        Returns:
            tuple: (response_dict, headers_dict)
        """
        # Capture full dict from _loop.generate()
        ts = str(int(time.time()))
        
        # Simulate _loop.generate() call - in real implementation this calls actual loop
        result = self._loop_generate(prompt, mode)
        
        # Extract metrics from result
        text = result.get('text', '')
        mean_depth = result.get('mean_depth')
        mean_contraction = result.get('mean_contraction')
        exit_reason = result.get('exit_reason')
        tokens = result.get('tokens', 0)
        q = result.get('q')
        
        # Prepare leaderboard record
        leaderboard_record = {
            'ts': ts,
            'mode': mode,
            'mean_depth': mean_depth,
            'mean_contraction': mean_contraction,
            'exit_reason': exit_reason,
            'tokens': tokens,
            'q': q,
        }
        
        # Append to leaderboard.jsonl
        self._append_to_leaderboard(leaderboard_record)
        
        # Prepare response headers
        headers = {}
        if mean_depth is not None:
            headers['x-ouro-depth'] = str(mean_depth)
        
        # Prepare response
        response = {
            'text': text,
            'ts': ts,
            'mode': mode,
            'mean_depth': mean_depth,
            'mean_contraction': mean_contraction,
            'exit_reason': exit_reason,
        }
        
        return response, headers
    
    def _loop_generate(self, prompt: str, mode: Optional[str] = None) -> Dict[str, Any]:
        """
        Simulate call to _loop.generate().
        In real implementation, this would call the actual LoopLM generator.
        """
        # This is a placeholder for the actual _loop.generate() call
        return {
            'text': 'Generated response',
            'mean_depth': 2.5,
            'mean_contraction': 0.8,
            'exit_reason': 'max_depth',
            'tokens': 100,
            'q': prompt,
        }
import json
import json