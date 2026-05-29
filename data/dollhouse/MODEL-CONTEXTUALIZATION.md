# Model Contextualization and Optimal Flow Convergence

## Current Model Restrictions (SWE-1.6 Slow)

### Known Constraints
- **Context Window**: Limited token capacity for extended conversations
- **Processing Speed**: "Slow" designation implies longer processing times
- **Tool Usage Limits**: Rate limiting on tool calls
- **Memory Constraints**: Conversation memory and context retention
- **File Reading Limits**: Truncation on large files
- **Parallel Processing**: Limited concurrent operations
- **Subagent Capabilities**: Available but with performance considerations

### Context Window Optimization
**Current Approach:**
- External memory via file system
- Git log as conversation memory
- Manifest files for system state
- Periodic conversation restarts

**Optimal Flow:**
```javascript
// Context-efficient workflow
1. Start with current state files (AGENTS.md, manifests)
2. Use targeted file reads (specific ranges, not full files)
3. Leverage git log for recent context
4. Store decisions to external files immediately
5. Restart conversations at natural boundaries
6. Use todo_write for task tracking across restarts
```

### Processing Speed Optimization
**Current Approach:**
- Sequential tool calls
- Single-operation focus
- Error recovery with retries

**Optimal Flow:**
```javascript
// Speed-efficient workflow
1. Batch independent operations where possible
2. Use subagents for parallelizable tasks
3. Prioritize critical path operations
4. Use background mode for long-running processes
5. Minimize wait times with proper timeout settings
6. Use grep/find for targeted file operations vs full reads
```

## Contextual Analysis of Current Workflow

### Current State Assessment
**Strengths:**
- Comprehensive documentation structure
- External memory system (file system, git)
- Convergence loop validation
- RAG dollhouse architecture
- Multi-repository integration plan

**Weaknesses:**
- Large file operations causing truncation
- Sequential processing vs parallel opportunities
- Context loss in extended conversations
- Overly ambitious single-conversation goals
- Lack of model-aware task chunking

### Optimal Task Chunking Strategy
**For SWE-1.6 Slow:**
```javascript
// Optimal chunk sizes
- Single file operations: 5-7 per conversation
- Multi-file operations: 3-4 per conversation
- Repository-wide operations: 1-2 per conversation
- Learning/analysis tasks: 2-3 per conversation
- Convergence loops: 1 per conversation

// Conversation boundaries
- Repository switches: Always restart
- Topic changes: Restart at 10-15 exchanges  
- Large file operations: Restart after 2-3 large reads
- Learning tasks: Restart after knowledge consolidation
- Convergence validation: Dedicated conversation
```

## Convergent Methods for Optimal Flow

### 1. Context-Aware Task Planning
```javascript
class ContextAwarePlanner {
    planTasks(modelConstraints, currentContext) {
        const chunks = this.breakDownWork(currentContext);
        
        return chunks.map(chunk => ({
            task: chunk.description,
            estimatedTokens: this.estimateTokenUsage(chunk),
            parallelizable: chunk.canRunParallel,
            conversationBoundary: chunk.requiresRestart,
            externalMemory: chunk.persistToFile
        }));
    }
    
    breakDownWork(work) {
        // Break large work into model-friendly chunks
        return work.map(item => ({
            ...item,
            chunked: this.optimizeForModel(item)
        }));
    }
}
```

### 2. External Memory Integration
```javascript
class ModelMemoryManager {
    constructor() {
        this.shortTerm = new Map(); // Current conversation
        this.longTerm = new Map();  // File system
        this.gitHistory = [];       // Git commits
    }
    
    // Store critical info externally
    async persistDecision(decision, context) {
        const filename = `data/context/decisions-${Date.now()}.md`;
        await this.writeToFile(filename, {
            decision,
            context,
            timestamp: new Date().toISOString()
        });
    }
    
    // Load context for conversation restart
    async loadContext(restartPoint) {
        const recentDecisions = await this.getRecentDecisions(restartPoint);
        const gitLog = await this.getGitHistory(5);
        const currentStatus = await this.readManifest('open-issues.md');
        
        return {
            recentDecisions,
            gitLog,
            currentStatus,
            restartPoint
        };
    }
}
```

### 3. Adaptive Processing Strategy
```javascript
class AdaptiveProcessor {
    constructor(modelType) {
        this.modelType = modelType;
        this.processingStrategy = this.selectStrategy(modelType);
    }
    
    selectStrategy(modelType) {
        if (modelType === 'SWE-1.6 Slow') {
            return {
                parallelMode: 'sequential',
                batchSize: 3,
                contextPreservation: 'external',
                restartFrequency: 'high',
                errorRecovery: 'conservative'
            };
        }
    }
    
    async processTask(task) {
        const strategy = this.processingStrategy;
        
        if (strategy.parallelMode === 'sequential') {
            return await this.sequentialProcess(task);
        } else {
            return await this.parallelProcess(task, strategy.batchSize);
        }
    }
}
```

## Optimal Flow for Current Work

### Phase 1: Dollhouse Integration (Context-Optimized)
**Conversation 1: Architecture and Setup**
- Task: Create dollhouse directory structure
- Files: 5-6 small files (< 100 lines each)
- External memory: Architecture decisions
- Restart after: Directory structure complete

**Conversation 2: Core Systems**
- Task: Implement self-correcting skills
- Files: 2-3 medium files (< 200 lines each)  
- External memory: Skill definitions
- Restart after: Core skills defined

**Conversation 3: Dashboard Integration**
- Task: Update dashboard HTML
- Files: 1 large file (edit sections)
- External memory: Integration decisions
- Restart after: Dashboard functional

### Phase 2: Multi-Repository Convergence
**Conversation 4: Repository Analysis**
- Task: Analyze current repository states
- Files: Multiple git operations, manifest reads
- External memory: Repository inventory
- Restart after: Analysis complete

**Conversation 5: Dependency Strategy**
- Task: Implement DEPs approach
- Files: Dependency manifests, git submodules
- External memory: Integration strategy
- Restart after: Dependencies configured

**Conversation 6: Dashboard Enhancement**
- Task: Add project centers to dashboard
- Files: Dashboard updates, repository cards
- External memory: UI decisions
- Restart after: Multi-repo UI complete

### Phase 3: Learning and Self-Correction
**Conversation 7: Book Learning Setup**
- Task: Configure learning engine
- Files: Learning configuration, book ingest
- External memory: Learning progress
- Restart after: Learning system active

**Conversation 8: Convergence Methods**
- Task: Implement novel convergence methods
- Files: Method implementations, integrations
- External memory: Method documentation
- Restart after: Novel methods deployed

## Current Model-Optimized Workflow

### Immediate Actions (This Conversation)
1. ✅ **Context Analysis**: Completed (this document)
2. 🔄 **Dollhouse Setup**: Create basic structure (external memory ready)
3. 🔄 **Dashboard Integration**: Update with dollhouse sections (targeted edits)
4. 🔄 **Repository Consolidation**: Implement DEPs approach (chunked)
5. 🔄 **Document Decisions**: Store to external memory files

### Conversation Restart Strategy
**When to Restart:**
- After completing dollhouse structure
- Before dashboard integration (large file edit)
- After repository analysis phase
- Before implementing novel convergence methods

**Restart Template:**
```
NEW CONVERSATION CONTEXT
Current Task: [specific next task]
Previous Work: [summary from external memory]
Current State: [read from git log + manifests]
External Memory: [files created in previous conversations]
Next Action: [immediate first step]
Model Considerations: [adapted workflow for SWE-1.6 Slow]
```

## Self-Correction for Model Constraints

### Error Detection
- **Context Loss**: Detect when I ask about recent information
- **File Truncation**: Watch for truncation notices
- **Performance Issues**: Monitor response times
- **Tool Failures**: Track tool error rates

### Adaptive Strategies
- **Context Loss**: Immediate restart with external memory
- **File Truncation**: Use targeted reads with line ranges
- **Performance Issues**: Reduce batch sizes, more restarts
- **Tool Failures**: Implement retry logic with backoff

### Optimal Parameter Tuning
```javascript
const SWE_1_6_SLOW_OPTIMAL = {
    maxFilesPerConversation: 5,
    maxTotalLines: 1000,
    maxParallelOps: 2,
    conversationLength: 12,
    restartThreshold: 3,
    externalMemoryFrequency: 'immediate',
    chunkSize: 'medium'
};
```

## Next Immediate Actions (Model-Optimized)

### Current Conversation Remaining Tasks
1. ✅ Complete contextual analysis document
2. 🔄 Create dollhouse basic structure (small files)
3. 🔄 Store decisions to external memory
4. 🔄 Prepare for conversation restart

### Next Conversation Plan
1. Load context from external memory
2. Continue dollhouse implementation (medium files)
3. Targeted dashboard edits (section-by-section)
4. Repository analysis (chunked operations)
5. Document decisions immediately

### Success Criteria for Optimal Flow
- ✅ No context loss between conversations
- ✅ No file truncation issues
- ✅ Consistent performance across restarts
- ✅ External memory reduces repetitive explanations
- ✅ Progressive task completion across boundaries
- ✅ Self-correcting based on model feedback

---

**Status:** Contextualization Complete  
**Next:** Restart conversation with external memory template  
**Goal:** Optimal flow for SWE-1.6 Slow model constraints