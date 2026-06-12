# Enhanced Dream Chat with Personal Development Cube

**Status:** design phase  
**Scope:** Enhance dream-chat.html to be the smartest coding assistant with personal cube integration and LoRA tuning  
**Target:** Most accurate chatbot for general coding tasks with personal development optimization

---

## Current Dream Chat Features

**Existing capabilities:**
- Multi-provider streaming (Claude, Gemini, OpenAI, Grok, Ollama)
- API key configuration and provider switching
- Observer panel with CSF stats (mood arc, symbols, convergence)
- Performance monitoring (tokens, cost, latency)
- Context modes (web search, CSF memory, trading)
- MCP connector integration
- Three Doors game integration
- Quick-start chips for various tasks

## Proposed Enhancements

### 1. Personal Development Cube Integration

**Cube data injection into chat context:**
- **GitHub state:** Current issues, PRs, workflow status
- **Provider status:** Rate limits, costs, availability
- **Environment status:** Server health, test results, git state
- **Current priorities:** Active tasks, blockers, next actions
- **Personal metrics:** Time spent, progress, workflow efficiency

**Implementation:**
```javascript
// Fetch personal cube data on chat initialization
async function loadPersonalCube() {
  const cubeData = await fetch('/api/cubes/alex/personal').then(r => r.json());
  
  // Inject into chat context
  window.personalContext = {
    github: cubeData.github,
    providers: cubeData.providers,
    environment: cubeData.environment,
    priorities: cubeData.priorities,
    metrics: cubeData.metrics
  };
  
  // Update UI with personal insights
  updatePersonalInsights(cubeData);
}

// Inject personal context into each chat request
async function sendMessage() {
  const personalContext = window.personalContext || {};
  const resp = await fetch('/api/dream/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: text,
      user: 'dream-chat',
      agent: '',
      provider,
      history: history.slice(-10),
      personalContext: personalContext  // NEW: personal cube data
    }),
  });
}
```

**UI enhancements:**
- **Personal insights panel:** Show current priorities, blockers, next actions
- **GitHub status badge:** Open issues, PRs, workflow status
- **Provider health indicators:** Rate limits, costs, availability
- **Environment status:** Server health, test results, git state
- **Personal metrics:** Time spent, progress, efficiency

### 2. Smart Coding Assistance Features

**Code-aware routing:**
- **Task detection:** Automatically identify coding tasks vs. general chat
- **Provider selection:** Choose optimal provider for coding tasks (Claude for code, Gemini for reasoning)
- **Context injection:** Inject relevant code files, git state, test results
- **Error recovery:** Automatic retry with different providers on code errors

**Implementation:**
```javascript
// Enhanced task detection for coding
function detectTaskType(message) {
  const codeKeywords = ['function', 'class', 'import', 'debug', 'fix', 'error', 'bug', 'refactor', 'implement'];
  const hasCodeKeyword = codeKeywords.some(kw => message.toLowerCase().includes(kw));
  const hasCodeBlock = message.includes('```') || message.includes('```');
  
  if (hasCodeKeyword || hasCodeBlock) {
    return 'coding';
  }
  return 'general';
}

// Provider selection based on task type
function selectProviderForTask(taskType) {
  if (taskType === 'coding') {
    // Prefer Claude for coding tasks
    return localStorage.getItem('ANTHROPIC_API_KEY') ? 'claude' : 'auto';
  }
  return 'auto';
}

// Context injection for coding tasks
async function injectCodingContext() {
  const context = {};
  
  // Git state
  const gitStatus = await fetch('/api/git/status').then(r => r.json());
  context.git = gitStatus;
  
  // Recent test results
  const testResults = await fetch('/api/tests/recent').then(r => r.json());
  context.tests = testResults;
  
  // Current file context (if in editor)
  const currentFile = await fetch('/api/editor/current').then(r => r.json());
  context.currentFile = currentFile;
  
  return context;
}
```

**UI enhancements:**
- **Code mode indicator:** Show when chat is in coding mode
- **Context panel:** Show injected code context (git state, tests, files)
- **Code suggestions:** Quick actions for common coding tasks
- **Error assistant:** Automatic error detection and fix suggestions

### 3. LoRA Tuning Capability

**LoRA training interface:**
- **Dataset preparation:** Upload training data, format validation
- **Model selection:** Choose base model (Llama, Mistral, etc.)
- **Training configuration:** Learning rate, epochs, batch size
- **Training progress:** Real-time loss curves, metrics
- **Model evaluation:** Test trained model, compare performance
- **Model deployment:** Deploy trained model to local inference

**Implementation:**
```javascript
// LoRA training interface
class LoRATrainer {
  async startTraining(config) {
    const resp = await fetch('/api/lora/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseModel: config.baseModel,
        dataset: config.dataset,
        learningRate: config.learningRate,
        epochs: config.epochs,
        batchSize: config.batchSize
      })
    });
    return resp.json();
  }
  
  async getTrainingProgress(jobId) {
    const resp = await fetch(`/api/lora/progress/${jobId}`);
    return resp.json();
  }
  
  async evaluateModel(modelId) {
    const resp = await fetch(`/api/lora/evaluate/${modelId}`);
    return resp.json();
  }
  
  async deployModel(modelId) {
    const resp = await fetch(`/api/lora/deploy/${modelId}`, { method: 'POST' });
    return resp.json();
  }
}
```

**UI enhancements:**
- **LoRA training panel:** Dataset upload, model selection, training config
- **Progress dashboard:** Real-time loss curves, training metrics
- **Model comparison:** Compare trained models with base model
- **Deployment controls:** Deploy trained model to local inference
- **Chat integration:** Use trained model in dream chat

### 4. Enhanced Accuracy Features

**Context-aware responses:**
- **Personal history:** Learn from previous coding tasks and preferences
- **Project context:** Understand project structure, conventions, patterns
- **Error patterns:** Learn from previous errors and fixes
- **Performance optimization:** Suggest optimizations based on personal metrics

**Implementation:**
```javascript
// Personal learning from coding tasks
class PersonalLearning {
  async recordCodingTask(task, result) {
    await fetch('/api/personal/learning', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: task,
        result: result,
        timestamp: Date.now()
      })
    });
  }
  
  async getPersonalPatterns() {
    const resp = await fetch('/api/personal/patterns');
    return resp.json();
  }
  
  async getSuggestions(context) {
    const patterns = await this.getPersonalPatterns();
    // Return personalized suggestions based on patterns
    return this.generateSuggestions(patterns, context);
  }
}
```

**UI enhancements:**
- **Personal suggestions:** Show personalized coding suggestions
- **Pattern recognition:** Highlight recurring patterns in code
- **Performance tips:** Suggest optimizations based on personal metrics
- **Learning dashboard:** Show learning progress and patterns

### 5. Implementation Steps

**Step 1: Add Personal Cube Integration**
- File: `apps/lantern-garage/public/dream-chat.html`
- Add personal cube data fetching on initialization
- Inject personal context into chat requests
- Add personal insights panel to UI

**Step 2: Implement Smart Coding Features**
- File: `apps/lantern-garage/public/dream-chat.html`
- Add task detection for coding vs. general chat
- Implement provider selection based on task type
- Add context injection for coding tasks
- Add code mode indicator and context panel

**Step 3: Add LoRA Training Interface**
- File: `apps/lantern-garage/public/dream-chat.html`
- Add LoRA training panel to settings
- Implement dataset upload and validation
- Add training progress dashboard
- Add model evaluation and deployment controls

**Step 4: Implement Personal Learning**
- File: `apps/lantern-garage/public/dream-chat.html`
- Add personal learning from coding tasks
- Implement pattern recognition
- Add personalized suggestions
- Add learning dashboard

**Step 5: Backend API Support**
- File: `apps/lantern-garage/routes/personal-cube.js`
- Add `/api/cubes/alex/personal` endpoint
- Add `/api/personal/learning` endpoint
- Add `/api/personal/patterns` endpoint
- Add `/api/lora/train` endpoint
- Add `/api/lora/progress/:jobId` endpoint
- Add `/api/lora/evaluate/:modelId` endpoint
- Add `/api/lora/deploy/:modelId` endpoint

**Step 6: Test and Validate**
- Test personal cube integration
- Test smart coding features
- Test LoRA training interface
- Test personal learning
- Validate accuracy improvements

### 6. Dependencies

**Python packages:**
```txt
peft>=0.6.0        # LoRA training
transformers>=4.30.0  # Model training
torch>=2.0.0       # PyTorch for training
datasets>=2.14.0   # Dataset handling
accelerate>=0.24.0  # Distributed training
```

**Backend files to create:**
- `apps/lantern-garage/routes/personal-cube.js` - Personal cube API
- `apps/lantern-garage/routes/lora-training.js` - LoRA training API
- `apps/lantern-garage/routes/personal-learning.js` - Personal learning API

**Frontend files to modify:**
- `apps/lantern-garage/public/dream-chat.html` - Enhanced chat interface
- `apps/lantern-garage/public/css/dream-chat.css` - New UI components

### 7. Validation Path

**Unit tests:**
```python
# tests/test_personal_cube_integration.py
def test_personal_cube_fetch():
    """Test personal cube data fetching."""
    
def test_personal_context_injection():
    """Test personal context injection into chat."""
    
def test_coding_task_detection():
    """Test coding task detection."""
    
def test_provider_selection():
    """Test provider selection based on task type."""
    
def test_lora_training():
    """Test LoRA training API."""
    
def test_personal_learning():
    """Test personal learning from coding tasks."""
```

**Integration tests:**
- Load personal cube data in dream chat
- Test smart coding features with real coding tasks
- Test LoRA training with sample dataset
- Test personal learning with coding history
- Validate accuracy improvements

**Performance targets:**
- Personal cube load: <500ms
- Task detection: <50ms
- Context injection: <200ms
- LoRA training: Depends on dataset size
- Chat latency: <2s with personal context
- Accuracy improvement: 20-30% on coding tasks

### 8. Safety Considerations

**Personal data protection:**
- No sensitive data in personal cube (status only)
- Encrypted storage for personal learning data
- User control over data retention
- Easy data deletion

**LoRA training safety:**
- Dataset validation before training
- Resource limits (GPU, memory)
- Training timeout protection
- Model validation before deployment

**Chat safety:**
- Provider fallback on errors
- Rate limiting on API calls
- Cost monitoring and alerts
- Human oversight for critical actions

### 9. Next Safe Action

Implement Step 1: Add Personal Cube Integration.

Modify `apps/lantern-garage/public/dream-chat.html` to add personal cube data fetching, context injection, and personal insights panel.

---

**Estimated effort:** 4-6 weeks for full implementation  
**Risk level:** Medium (involves ML training, personal data)  
**Safety requirement:** No sensitive data in cube, validation before LoRA deployment  
**Validation requirement:** Test with real personal cube data and coding tasks
