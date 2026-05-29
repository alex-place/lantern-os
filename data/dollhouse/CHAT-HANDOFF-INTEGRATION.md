# Chat Handoff Integration for Active Fleet

## Purpose
Capture raw contexts from chat handoffs and immediately dispatch to active agent fleet for processing and convergence.

## Integration Points

### Lantern OS ↔ Orchestrator Integration
```powershell
# Lantern OS chat handoff → Orchestrator active fleet
function Send-LanternChatHandoff {
    param([string]$chatInput)
    
    $handoffContext = @{
        timestamp = Get-Date
        source = "lantern-os-chat"
        rawInput = $chatInput
        dollhouseContext = Get-DollhouseContext
        convergenceRequired = $true
    }
    
    # Send to orchestrator active fleet
    Invoke-OrchestratorHandoff -Context $handoffContext
}
```

### Dollhouse Skills Integration
```powershell
function Get-DollhouseContext {
    return @{
        skills = Get-ActiveDollhouseSkills
        knowledgeBase = Get-KnowledgeBaseSize
        learningProgress = Get-LearningProgress
        convergenceMethods = Get-ConvergenceMethods
    }
}
```

## Real-time Task Processing

### Immediate Processing Flow
```powershell
# Each typed task → Immediate fleet processing → MCP response
function Process-TypedTask {
    param([string]$taskInput)
    
    # 1. Capture raw context immediately
    $context = @{
        input = $taskInput
        timestamp = Get-Date
        source = "direct-input"
        priority = "immediate"
    }
    
    # 2. Dispatch to active fleet (no queue)
    $taskId = New-Guid
    $agent = Get-ActiveAgent
    
    # 3. Process with dollhouse skills
    $result = Invoke-AgentProcessing -Agent $agent -Context $context
    
    # 4. Apply self-correction
    $corrected = Apply-DollhouseSkills -Result $result
    
    # 5. Fleet convergence
    $converged = Invoke-FleetConvergence -TaskId $taskId -Result $corrected
    
    # 6. MCP response
    Send-McpResponse -TaskId $taskId -Result $converged
    
    return $converged
}
```

## Fleet Status Monitoring

### Real-time Status Dashboard
```powershell
function Get-ActiveFleetStatus {
    return @{
        activeAgents = Get-ActiveAgentCount
        processingTasks = Get-ProcessingTaskCount
        mcpResponses = Get-McpResponseCount
        convergenceRate = Get-ConvergenceRate
        dollhouseIntegration = Get-DollhouseIntegrationStatus
        averageProcessingTime = Get-AverageProcessingTime
        lastActivity = Get-LastActivityTime
    }
}
```

## Self-Correction Integration

### Dollhouse Skills Application
```powershell
function Apply-DollhouseSkills {
    param([hashtable]$taskResult)
    
    # Load dollhouse skills
    $skills = @(
        @{ name = "error-correction"; enabled = $true }
        @{ name = "adaptive-learning"; enabled = $true }
        @{ name = "convergence-optimization"; enabled = $true }
    )
    
    # Apply each skill
    foreach ($skill in $skills) {
        if ($skill.enabled) {
            $taskResult = Invoke-DollhouseSkill -Skill $skill.name -Input $taskResult
        }
    }
    
    $taskResult['dollhouseSkillsApplied'] = $skills.Count
    return $taskResult
}
```

## MCP Response Integration

### Response Formatting
```powershell
function Send-McpResponse {
    param([string]$taskId, [hashtable]$result)
    
    $response = @{
        taskId = $taskId
        timestamp = Get-Date
        status = "completed"
        result = $result
        metadata = @{
            fleetConverged = $true
            dollhouseSkillsApplied = $result.dollhouseSkillsApplied
            processingTime = $result.processingTime
            agentsInvolved = $result.agentsInvolved
        }
    }
    
    # Send to MCP server
    $mcpEndpoint = "http://127.0.0.1:8787/mcp"
    Invoke-RestMethod -Uri $mcpEndpoint -Method Post -Body ($response | ConvertTo-Json) -ContentType "application/json"
}
```

## Deployment Configuration

### Agent Configuration Update
```json
// config/agents.json addition
{
  "activeProcessing": {
    "enabled": true,
    "chatHandoffIntegration": true,
    "immediateDispatch": true,
    "mcpResponseRequired": true,
    "dollhouseSkillsEnabled": true,
    "fleetConvergence": true
  }
}
```

### Service Integration
```powershell
# Start active fleet service
Start-ActiveAgentFleet -McpServerUrl "http://127.0.0.1:8787" -NoAuth

# Enable chat handoff monitoring
Enable-ChatHandoffMonitoring -ContinuousProcessing

# Integrate with dollhouse
Enable-DollhouseIntegration -Skills @("error-correction","adaptive-learning","convergence-optimization")
```

## Success Criteria
- ✅ Chat handoffs captured immediately
- ✅ Tasks dispatched to active fleet (no queue delay)
- ✅ Each task converged with dollhouse skills
- ✅ MCP responses sent for each task
- ✅ Standby agents activated as needed
- ✅ Real-time fleet status available
- ✅ Self-correction applied to all tasks