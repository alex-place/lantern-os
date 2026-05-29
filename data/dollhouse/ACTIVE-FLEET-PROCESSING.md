# Active Agent Fleet Processing System

## Purpose
Enable orchestrator agents to actively process raw contexts from chat handoffs, converge tasks in the fleet, and respond via MCP instead of standby mode.

## Current State Analysis
**Problem:** Agent fleet is in standby/dispatch mode, not actively processing chat handoffs
**Desired State:** Active fleet that takes raw contexts, converges each task, responds via MCP

## Architecture

### Active Fleet Processing Flow
```
Chat Handoff → Raw Context Capture → Fleet Processing → Task Convergence → MCP Response
```

### Components
1. **Chat Handoff Interface**: Capture raw contexts from chat
2. **Active Fleet Manager**: Dispatch tasks to available agents
3. **Task Convergence Engine**: Self-correcting skill integration
4. **MCP Response System**: Real-time responses for each task
5. **Fleet Status Monitor**: Active agent tracking

## Implementation

### Active Fleet Manager
```powershell
class ActiveFleetManager {
    [hashtable]$Agents
    [hashtable]$ActiveTasks
    [string]$McpServerUrl
    
    ActiveFleetManager([string]$mcpServerUrl) {
        $this.McpServerUrl = $mcpServerUrl
        $this.Agents = @{}
        $this.ActiveTasks = @{}
    }
    
    # Process chat handoff immediately
    [void]ProcessChatHandoff([hashtable]$context) {
        $taskId = $this.GenerateTaskId($context)
        
        # Dispatch to fleet immediately (no queue delay)
        $assignedAgent = $this.DispatchToAgent($taskId, $context)
        
        # Process with self-correcting skills
        $result = $this.ProcessWithSkills($assignedAgent, $context)
        
        # Converge in fleet
        $converged = $this.ConvergeTask($taskId, $result)
        
        # Respond via MCP
        $this.SendMcpResponse($taskId, $converged)
    }
    
    [string]DispatchToAgent([string]$taskId, [hashtable]$context) {
        # Find available agent immediately
        $availableAgent = $this.FindAvailableAgent()
        
        if ($availableAgent) {
            $this.ActiveTasks[$taskId] = @{
                agent = $availableAgent
                context = $context
                startTime = Get-Date
                status = "processing"
            }
            return $availableAgent
        }
        
        # If no agent available, activate standby agent
        return $this.ActivateStandbyAgent()
    }
}
```

### Chat Handoff Interface
```powershell
class ChatHandoffInterface {
    [string]$HandoffLogPath
    [ActiveFleetManager]$FleetManager
    
    ChatHandoffInterface([string]$logPath, [ActiveFleetManager]$fleetManager) {
        $this.HandoffLogPath = $logPath
        $this.FleetManager = $fleetManager
    }
    
    # Capture raw context from chat
    [hashtable]CaptureChatContext([string]$chatInput) {
        return @{
            timestamp = Get-Date
            rawInput = $chatInput
            source = "chat-handoff"
            priority = $this.DeterminePriority($chatInput)
            context = $this.ExtractContext($chatInput)
        }
    }
    
    # Process immediately upon capture
    [void]ProcessHandoff([string]$chatInput) {
        $context = $this.CaptureChatContext($chatInput)
        
        # Log handoff
        $this.LogHandoff($context)
        
        # Dispatch to active fleet immediately
        $this.FleetManager.ProcessChatHandoff($context)
    }
}
```

### Task Convergence Engine
```powershell
class TaskConvergenceEngine {
    [hashtable]$Skills
    
    TaskConvergenceEngine() {
        $this.Skills = @{}
        $this.InitializeSkills()
    }
    
    [void]InitializeSkills() {
        # Load self-correcting skills from dollhouse
        $this.Skills['error-correction'] = $this.LoadSkill('error-correction')
        $this.Skills['adaptive-learning'] = $this.LoadSkill('adaptive-learning')
        $this.Skills['convergence-optimization'] = $this.LoadSkill('convergence-optimization')
    }
    
    [hashtable]ConvergeTask([string]$taskId, [hashtable]$taskResult) {
        $converged = $taskResult
        
        # Apply self-correcting skills
        foreach ($skillName in $this.Skills.Keys) {
            $skill = $this.Skills[$skillName]
            $converged = $skill.Apply($converged)
        }
        
        # Fleet convergence
        $converged = $this.FleetConverge($taskId, $converged)
        
        return $converged
    }
    
    [hashtable]FleetConverge([string]$taskId, [hashtable]$result) {
        # Synchronize with other fleet tasks
        $fleetState = $this.GetFleetState()
        
        # Apply fleet-wide convergence
        $result['fleetConverged'] = $true
        $result['fleetTimestamp'] = Get-Date
        $result['fleetAgents'] = $fleetState.activeAgents
        
        return $result
    }
}
```

### MCP Response System
```powershell
class McpResponseSystem {
    [string]$McpServerUrl
    
    McpResponseSystem([string]$mcpServerUrl) {
        $this.McpServerUrl = $mcpServerUrl
    }
    
    [void]SendMcpResponse([string]$taskId, [hashtable]$convergedResult) {
        $response = @{
            taskId = $taskId
            timestamp = Get-Date
            status = "completed"
            result = $convergedResult
            fleetConverged = $true
            skillsApplied = $convergedResult.skillsApplied
        }
        
        # Send to MCP endpoint
        $this.SendToMcpEndpoint($response)
    }
    
    [void]SendToMcpEndpoint([hashtable]$response) {
        $endpoint = "$($this.McpServerUrl)/mcp"
        
        try {
            Invoke-RestMethod -Uri $endpoint -Method Post -Body ($response | ConvertTo-Json) -ContentType "application/json"
        }
        catch {
            Write-Error "Failed to send MCP response: $_"
        }
    }
}
```

## Integration with Existing System

### Modify Agent Configuration
Update `config/agents.json` to enable active processing:

```json
{
  "activeProcessing": true,
  "chatHandoffEnabled": true,
  "immediateDispatch": true,
  "fleetConvergence": true,
  "mcpResponseRequired": true
}
```

### Create Active Processing Script
```powershell
# scripts\Start-ActiveAgentFleet.ps1
param(
    [string]$McpServerUrl = "http://127.0.0.1:8787",
    [string]$HandoffLogPath = "logs/chat-handoffs.log"
)

# Initialize components
$fleetManager = [ActiveFleetManager]::new($McpServerUrl)
$handoffInterface = [ChatHandoffInterface]::new($HandoffLogPath, $fleetManager)
$convergenceEngine = [TaskConvergenceEngine]::new()
$mcpResponse = [McpResponseSystem]::new($McpServerUrl)

# Start active processing
Write-Host "Starting active agent fleet processing..."
Write-Host "MCP Server: $McpServerUrl"
Write-Host "Handoff Log: $HandoffLogPath"

# Monitor for chat handoffs
while ($true) {
    # Check for new chat handoffs
    $handoffs = $handoffInterface.GetPendingHandoffs()
    
    foreach ($handoff in $handoffs) {
        # Process immediately
        $handoffInterface.ProcessHandoff($handoff.rawInput)
    }
    
    Start-Sleep -Seconds 1
}
```

## Fleet Activation Strategy

### Standby Agent Activation
```powershell
function ActivateStandbyAgent {
    param([string]$agentSlot)
    
    # Check agent status
    $agentStatus = Get-AgentStatus -Slot $agentSlot
    
    if ($agentStatus.status -eq "standby") {
        # Activate agent immediately
        Set-AgentStatus -Slot $agentSlot -Status "active"
        Start-AgentProcess -Slot $agentSlot
        
        Write-Host "Activated standby agent: $agentSlot"
        return $true
    }
    
    return $false
}
```

### Real-time Task Processing
```powershell
function ProcessTaskRealTime {
    param([hashtable]$taskContext)
    
    # No queue delay - process immediately
    $taskId = New-Guid
    
    # Assign to available agent
    $agent = Get-AvailableAgent
    
    # Process with active fleet
    $result = Invoke-AgentProcessing -Agent $agent -Task $taskContext
    
    # Apply convergence
    $converged = Invoke-TaskConvergence -TaskId $taskId -Result $result
    
    # Send MCP response
    Send-McpResponse -TaskId $taskId -Result $converged
}
```

## Monitoring and Status

### Fleet Status Dashboard
```powershell
function Get-FleetStatus {
    return @{
        activeAgents = Get-ActiveAgentCount
        processingTasks = Get-ProcessingTaskCount
        queueDepth = Get-QueueDepth
        mcpResponses = Get-McpResponseCount
        convergenceRate = Get-ConvergenceRate
        averageProcessingTime = Get-AverageProcessingTime
    }
}
```

### Self-Correction Integration
```powershell
function ApplySelfCorrection {
    param([hashtable]$taskResult)
    
    # Load dollhouse skills
    $skills = Get-DollhouseSkills
    
    # Apply relevant skills
    foreach ($skill in $skills) {
        if ($skill.IsApplicable($taskResult)) {
            $taskResult = $skill.Correct($taskResult)
        }
    }
    
    return $taskResult
}
```

## Deployment

### Installation Steps
1. Update agent configuration for active processing
2. Create active fleet processing script
3. Enable chat handoff interface
4. Start MCP server with no-auth for local use
5. Activate standby agents
6. Monitor fleet performance

### Verification
```powershell
# Test active processing
Test-ActiveFleetProcessing -TestContext @{ input = "test task" }

# Verify MCP responses
Test-McpResponseEndpoint -ServerUrl "http://127.0.0.1:8787"

# Check fleet status
Get-FleetStatus
```

## Success Criteria
- ✅ Agents process chat handoffs immediately (no queue delay)
- ✅ Each task converged in fleet with self-correcting skills
- ✅ MCP responses sent for each processed task
- ✅ Standby agents activated when needed
- ✅ Fleet status monitored in real-time
- ✅ No agents in permanent standby mode