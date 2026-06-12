# Focused Internet Map Status Cube

**Status:** design phase  
**Scope:** Map internet as it applies to Lantern OS, Dream Chat, and Trading  
**Target:** <100MB compressed cube for focused ecosystem understanding + action intersection

---

## Problem Statement

Instead of mapping the entire internet, focus on the specific internet ecosystem that Lantern OS interacts with:
- **Lantern OS GitHub**: Issues, PRs, workflows, releases
- **Dream Chat Providers**: APIs, models, endpoints, rate limits
- **Trading Sources**: Markets, signals, exchanges, data feeds

**Goal:** Create a focused Status Cube that understands this specific ecosystem and determines optimal digital actions.

## Proposed Solution

### 1. Focused Ecosystem Mapping

**Lantern OS GitHub Ecosystem:**
- Repository: `alex-place/lantern-os`
- Issues: Open/closed issues with labels (dream-journal, agent-task, three-doors)
- Pull Requests: Open/closed PRs with status
- Workflows: GitHub Actions (smart-convergence-loop, slop-check, etc.)
- Releases: Version tags, changelog entries
- Branches: Feature branches, master, gh-pages

**Dream Chat Provider Ecosystem:**
- **Anthropic Claude**: API endpoints, models (haiku-4-5, opus), rate limits, pricing
- **Google Gemini**: API endpoints, models (2.5-flash), rate limits, pricing
- **OpenAI**: API endpoints, models (gpt-4), rate limits, pricing
- **xAI Grok**: API endpoints, models, rate limits, pricing
- **Ollama**: Local models, endpoints, model availability

**Trading Data Ecosystem:**
- **Kalshi**: Prediction markets, contracts, API endpoints
- **Market Data**: Price feeds, volume, liquidity
- **Trading Signals**: AI trader signals, strategy outputs
- **Exchanges**: Order books, trade history, market status

### 2. Focused Status Cube Structure (Sparse Matrix Design)

**Current CSF:** 3^12 = 531K cells (sparse design)  
**Use existing sparse matrix** - no expansion needed

**4D Status Cube Navigation (per Tesseract Convergence Loop):**

| Axis | Meaning | Focused Ecosystem Mapping |
|------|---------|---------------------------|
| **x** | location (body, device, repo, product) | GitHub repo, provider endpoints, trading exchanges |
| **y** | module lane (repo control, report, dollhouse, wallet, device, product) | GitHub lane, provider lane, trading lane |
| **z** | boundary (proven, candidate, held, blocked) | Action safety states, API availability, market status |
| **t** | timeline (current evidence, last validation, next receipt) | Issue timestamps, API rate limits, trading signals |

**Sparse cell allocation (focused ecosystem):**
- **GitHub cells:** ~50K active cells (issues, PRs, workflows) - sparse in 531K matrix
- **Provider cells:** ~30K active cells (API status, models, rate limits) - sparse
- **Trading cells:** ~20K active cells (markets, signals, exchanges) - sparse
- **Action cells:** ~10K active cells (action history, dependencies) - sparse
- **Total active:** ~110K cells out of 531K (21% density) - highly sparse

**Compression strategy (existing CSF sparse design):**
- Dictionary encoding: Recurring patterns (issue labels, API endpoints, market symbols)
- Sparse CSR: Exploits 79% sparsity (most cells empty)
- Delta encoding: Sequential updates (new issues, API status changes, price movements)
- Zstd compression: Level 19 for maximum compression

**Size estimate:**
- Uncompressed: ~50 MB (110K active cells × 100 bytes each)
- Compressed: ~5-10 MB (5-10x reduction with sparse CSR)
- **Target: <100MB ✓**

### 3. Understanding Layer for Focused Ecosystem

**Implementation:**
```python
# src/csf/focused_ecosystem_understanding.py
class FocusedEcosystemUnderstanding:
    """Understanding of Lantern OS/Dream Chat/Trading ecosystem."""
    
    def __init__(self):
        self.github_monitor = GitHubMonitor()  # Issues, PRs, workflows
        self.provider_monitor = ProviderMonitor()  # API status, models, limits
        self.trading_monitor = TradingMonitor()  # Markets, signals, exchanges
        self.pattern_recognizer = PatternRecognizer()  # Recurring patterns
    
    def understand_github_state(self) -> GitHubUnderstanding:
        """Understand current GitHub state."""
        issues = self.github_monitor.get_issues()
        prs = self.github_monitor.get_pull_requests()
        workflows = self.github_monitor.get_workflows()
        return GitHubUnderstanding(issues, prs, workflows)
    
    def understand_provider_state(self) -> ProviderUnderstanding:
        """Understand current provider states."""
        anthropic = self.provider_monitor.check_anthropic()
        gemini = self.provider_monitor.check_gemini()
        openai = self.provider_monitor.check_openai()
        xai = self.provider_monitor.check_xai()
        ollama = self.provider_monitor.check_ollama()
        return ProviderUnderstanding(anthropic, gemini, openai, xai, ollama)
    
    def understand_trading_state(self) -> TradingUnderstanding:
        """Understand current trading state."""
        kalshi = self.trading_monitor.get_kalshi_markets()
        signals = self.trading_monitor.get_signals()
        exchanges = self.trading_monitor.get_exchanges()
        return TradingUnderstanding(kalshi, signals, exchanges)
```

### 4. Action Intersection for Focused Ecosystem

**GitHub Actions:**
- Create issue (when new task identified)
- Update issue status (when progress made)
- Create PR (when code ready)
- Merge PR (when approved)
- Trigger workflow (when needed)

**Provider Actions:**
- Switch provider (when current provider fails)
- Adjust rate limits (when hitting limits)
- Update model selection (when better model available)
- Cache responses (when latency high)

**Trading Actions:**
- Place order (when signal strong)
- Cancel order (when conditions change)
- Update position (when market moves)
- Adjust strategy (when performance drops)

**Implementation:**
```python
# src/csf/focused_action_intersection.py
class FocusedActionIntersection:
    """Determine next actions for focused ecosystem."""
    
    def __init__(self):
        self.github_analyzer = GitHubActionAnalyzer()
        self.provider_analyzer = ProviderActionAnalyzer()
        self.trading_analyzer = TradingActionAnalyzer()
        self.prioritizer = ActionPrioritizer()
    
    def intersect_github_action(self, understanding: GitHubUnderstanding) -> Action:
        """Determine next GitHub action."""
        candidates = self.github_analyzer.analyze(understanding)
        return self.prioritizer.rank(candidates)[0]
    
    def intersect_provider_action(self, understanding: ProviderUnderstanding) -> Action:
        """Determine next provider action."""
        candidates = self.provider_analyzer.analyze(understanding)
        return self.prioritizer.rank(candidates)[0]
    
    def intersect_trading_action(self, understanding: TradingUnderstanding) -> Action:
        """Determine next trading action."""
        candidates = self.trading_analyzer.analyze(understanding)
        return self.prioritizer.rank(candidates)[0]
```

### 5. Implementation Steps

**Step 1: Map Lantern OS GitHub Ecosystem**
- File: `src/csf/github_ecosystem_mapper.py`
- Implement GitHub API client (issues, PRs, workflows)
- Create data structures for GitHub state
- Add pattern recognition for GitHub events

**Step 2: Map Dream Chat Provider Ecosystem**
- File: `src/csf/provider_ecosystem_mapper.py`
- Implement provider status checks (Anthropic, Gemini, OpenAI, xAI, Ollama)
- Create data structures for provider state
- Add rate limit monitoring

**Step 3: Map Trading Data Ecosystem**
- File: `src/csf/trading_ecosystem_mapper.py`
- Implement Kalshi market data client
- Create data structures for trading state
- Add signal processing

**Step 4: Create Focused Status Cube**
- File: `src/csf/focused_status_cube.py`
- Use existing 3^12 sparse matrix (531K cells)
- Map focused ecosystem into 4D navigation axes
- Leverage existing sparse CSR compression

**Step 5: Implement Action Intersection**
- File: `src/csf/focused_action_intersection.py`
- Implement GitHub action analyzer
- Implement provider action analyzer
- Implement trading action analyzer
- Add action prioritization

**Step 6: Integrate with Convergence Engine**
- File: `src/convergence_io_engine.py`
- Add phases 21-24 for focused ecosystem processing
- Integrate ecosystem monitors
- Connect action intersection engine

### 6. Dependencies

**Python packages:**
```txt
zstandard>=0.22.0  # Compression
pygithub>=2.0.0     # GitHub API
anthropic>=0.102.0  # Anthropic API
google-generativeai>=0.3.0  # Gemini API
openai>=1.0.0       # OpenAI API
requests>=2.31.0   # HTTP client
```

**CSF files to modify:**
- `src/csf/v07/csf_file.py` - Extended header for ecosystem metadata
- `src/csf/v07/classical_compressor.py` - Optimize for ecosystem patterns
- `src/convergence_io_engine.py` - Add focused ecosystem phases

### 7. Validation Path

**Unit tests:**
```python
# tests/test_focused_status_cube.py
def test_github_ecosystem_mapping():
    """Test GitHub ecosystem mapping."""
    
def test_provider_ecosystem_mapping():
    """Test provider ecosystem mapping."""
    
def test_trading_ecosystem_mapping():
    """Test trading ecosystem mapping."""
    
def test_focused_cube_compression():
    """Test cube fits in <100MB."""
    
def test_action_intersection():
    """Test action intersection for focused ecosystem."""
```

**Integration tests:**
- Map real Lantern OS GitHub state
- Monitor real Dream Chat provider status
- Fetch real trading data
- Create compressed cube
- Validate action intersection

**Performance targets:**
- Cube size: <100MB compressed
- GitHub mapping: <30s
- Provider monitoring: <10s
- Trading data fetch: <15s
- Action intersection: <500ms
- Convergence time: <5min for focused ecosystem phases

### 8. Safety Considerations

**GitHub actions:**
- All GitHub actions require human approval
- Dry-run mode for issue/PR creation
- Review before merging PRs
- Audit trail of all GitHub actions

**Provider actions:**
- Provider switching requires confirmation
- Rate limit changes monitored
- Model selection logged
- Fallback to safe defaults

**Trading actions:**
- All trading actions require explicit approval
- Position limits enforced
- Risk checks before orders
- Emergency stop capability

**Cube safety:**
- Encryption of sensitive sections
- Access control on cube file
- Backup before major actions
- Corruption detection

### 9. Next Safe Action

Implement Step 1: Map Lantern OS GitHub Ecosystem.

Create `src/csf/github_ecosystem_mapper.py` with GitHub API client, data structures, and pattern recognition.

---

**Estimated effort:** 2-3 weeks for full implementation  
**Risk level:** Medium (focused scope, human approval required)  
**Safety requirement:** Human approval for all actions  
**Validation requirement:** Test with real Lantern OS GitHub data
