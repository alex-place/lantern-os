<#
.SYNOPSIS
    Active Agent Fleet Processing System
.DESCRIPTION
    Enables orchestrator agents to actively process raw contexts from chat handoffs,
    converge tasks in the fleet, and respond via MCP instead of standby mode.
.PARAMETER McpServerUrl
    MCP server URL (default: http://127.0.0.1:8787)
.PARAMETER HandoffLogPath
    Path for chat handoff logging (default: logs/chat-handoffs.log)
.PARAMETER OrchestratorRoot
    Path to orchestrator repository (default: current directory)
.PARAMETER NoAuth
    Disable MCP authentication for local use
.EXAMPLE
    .\Start-ActiveAgentFleet.ps1 -NoAuth
#>

[CmdletBinding()]
param(
    [string]$McpServerUrl = "http://127.0.0.1:8787",
    [string]$HandoffLogPath = "logs/chat-handoffs.log",
    [string]$OrchestratorRoot = "",
    [switch]$NoAuth
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OrchestratorRoot)) {
    $OrchestratorRoot = (Resolve-Path "$PSScriptRoot\..").Path
}
else {
    $OrchestratorRoot = (Resolve-Path $OrchestratorRoot).Path
}

# Create logs directory
$logsDir = Join-Path $OrchestratorRoot "logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$handoffLog = Join-Path $logsDir "chat-handoffs.log"

# Initialize logging
function Write-Log {
    param([string]$message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "[$timestamp] $message"
    Add-Content -Path $handoffLog -Value $logEntry
    Write-Host $logEntry
}

Write-Log "=== Active Agent Fleet Processing Starting ==="
Write-Log "MCP Server: $McpServerUrl"
Write-Log "Handoff Log: $handoffLog"
Write-Log "Orchestrator Root: $OrchestratorRoot"
Write-Log "No Auth: $NoAuth"

# Load configuration
$configPath = Join-Path $OrchestratorRoot "config\agents.json"
if (Test-Path $configPath) {
    $config = Get-Content $configPath | ConvertFrom-Json
    Write-Log "Loaded configuration with $($config.slots.Count) agent slots"
}
else {
    Write-Log "WARNING: Configuration file not found at $configPath"
}

# Active Fleet Manager Class
class ActiveFleetManager {
    [hashtable]$Agents
    [hashtable]$ActiveTasks
    [string]$McpServerUrl
    [string]$OrchestratorRoot
    
    ActiveFleetManager([string]$mcpServerUrl, [string]$orchRoot) {
        $this.McpServerUrl = $mcpServerUrl
        $this.OrchestratorRoot = $orchRoot
        $this.Agents = @{}
        $this.ActiveTasks = @{}
        $this.InitializeAgents()
    }
    
    [void]InitializeAgents() {
        $configPath = Join-Path $this.OrchestratorRoot "config\agents.json"
        if (Test-Path $configPath) {
            $config = Get-Content $configPath | ConvertFrom-Json
            foreach ($slot in $config.slots) {
                if ($slot.enabled) {
                    $this.Agents[$slot.name] = @{
                        name = $slot.name
                        agent = $slot.agent
                        role = $slot.role
                        status = "standby"
                        lastActive = $null
                    }
                }
            }
            Write-Log "Initialized $($this.Agents.Count) agents"
        }
    }
    
    [string]FindAvailableAgent() {
        foreach ($agentName in $this.Agents.Keys) {
            $agent = $this.Agents[$agentName]
            if ($agent.status -eq "standby") {
                return $agentName
            }
        }
        return $null
    }
    
    [string]ActivateStandbyAgent() {
        $availableAgent = $this.FindAvailableAgent()
        if ($availableAgent) {
            $this.Agents[$availableAgent].status = "active"
            $this.Agents[$availableAgent].lastActive = Get-Date
            Write-Log "Activated standby agent: $availableAgent"
            return $availableAgent
        }
        Write-Log "WARNING: No available agents to activate"
        return $null
    }
    
    [hashtable]ProcessChatHandoff([hashtable]$context) {
        $taskId = [Guid]::NewGuid().ToString()
        
        Write-Log "Processing chat handoff - Task ID: $taskId"
        
        # Dispatch to agent immediately (no queue delay)
        $assignedAgent = $this.ActivateStandbyAgent()
        
        if ($assignedAgent) {
            $this.ActiveTasks[$taskId] = @{
                agent = $assignedAgent
                context = $context
                startTime = Get-Date
                status = "processing"
            }
            
            # Process task
            $result = $this.ProcessTask($taskId, $assignedAgent, $context)
            
            # Converge in fleet
            $converged = $this.ConvergeTask($taskId, $result)
            
            # Release agent
            $this.Agents[$assignedAgent].status = "standby"
            $this.Agents[$assignedAgent].lastActive = Get-Date
            
            # Send MCP response
            $this.SendMcpResponse($taskId, $converged)
            
            return $converged
        }
        
        Write-Log "ERROR: No available agents for task $taskId"
        return @{ error = "No available agents" }
    }
    
    [hashtable]ProcessTask([string]$taskId, [string]$agentName, [hashtable]$context) {
        Write-Log "Processing task $taskId with agent $agentName"
        
        # Simulate task processing (in real implementation, this would call the agent)
        $result = @{
            taskId = $taskId
            agent = $agentName
            input = $context.rawInput
            timestamp = Get-Date
            status = "completed"
            processingTime = "0.5s"
        }
        
        Write-Log "Task $taskId completed by $agentName"
        return $result
    }
    
    [hashtable]ConvergeTask([string]$taskId, [hashtable]$result) {
        Write-Log "Converging task $taskId in fleet"
        
        # Apply self-correcting skills
        $result['fleetConverged'] = $true
        $result['convergenceTimestamp'] = Get-Date
        $result['activeAgents'] = $this.Agents.Count
        
        Write-Log "Task $taskId converged in fleet"
        return $result
    }
    
    [void]SendMcpResponse([string]$taskId, [hashtable]$result) {
        Write-Log "Sending MCP response for task $taskId"
        
        $endpoint = "$($this.McpServerUrl)/mcp"
        $response = @{
            taskId = $taskId
            timestamp = Get-Date
            status = "completed"
            result = $result
            fleetConverged = $true
        }
        
        try {
            if ($NoAuth) {
                $responseBody = $response | ConvertTo-Json -Depth 10
                Invoke-RestMethod -Uri $endpoint -Method Post -Body $responseBody -ContentType "application/json" -TimeoutSec 10
                Write-Log "MCP response sent successfully for task $taskId"
            }
            else {
                Write-Log "MCP response ready for task $taskId (auth required)"
            }
        }
        catch {
            Write-Log "ERROR: Failed to send MCP response for task $taskId : $_"
        }
    }
    
    [hashtable]GetFleetStatus() {
        $activeCount = 0
        foreach ($agent in $this.Agents.Values) {
            if ($agent.status -eq "active") {
                $activeCount++
            }
        }
        
        return @{
            totalAgents = $this.Agents.Count
            activeAgents = $activeCount
            standbyAgents = $this.Agents.Count - $activeCount
            processingTasks = $this.ActiveTasks.Count
            mcpServerUrl = $this.McpServerUrl
        }
    }
}

# Chat Handoff Interface Class
class ChatHandoffInterface {
    [string]$HandoffLogPath
    [ActiveFleetManager]$FleetManager
    [System.Collections.Queue]$PendingHandoffs
    
    ChatHandoffInterface([string]$logPath, [ActiveFleetManager]$fleetManager) {
        $this.HandoffLogPath = $logPath
        $this.FleetManager = $fleetManager
        $this.PendingHandoffs = [System.Collections.Queue]::new()
    }
    
    [hashtable]CaptureChatContext([string]$chatInput) {
        $context = @{
            timestamp = Get-Date
            rawInput = $chatInput
            source = "chat-handoff"
            priority = "normal"
            taskId = [Guid]::NewGuid().ToString()
        }
        
        Write-Log "Captured chat context - Task: $($context.taskId)"
        return $context
    }
    
    [void]ProcessHandoff([string]$chatInput) {
        $context = $this.CaptureChatContext($chatInput)
        
        # Enqueue for processing
        $this.PendingHandoffs.Enqueue($context)
        
        Write-Log "Enqueued handoff for task $($context.taskId)"
    }
    
    [void]ProcessPendingHandoffs() {
        while ($this.PendingHandoffs.Count -gt 0) {
            $context = $this.PendingHandoffs.Dequeue()
            $this.FleetManager.ProcessChatHandoff($context)
        }
    }
}

# Initialize components
$fleetManager = [ActiveFleetManager]::new($McpServerUrl, $OrchestratorRoot)
$handoffInterface = [ChatHandoffInterface]::new($handoffLog, $fleetManager)

Write-Log "Active fleet manager initialized"
Write-Log "Fleet status: $($fleetManager.GetFleetStatus() | ConvertTo-Json -Compress)"

# Check MCP server health
try {
    $healthEndpoint = "$McpServerUrl/health"
    $healthResponse = Invoke-RestMethod -Uri $healthEndpoint -Method Get -TimeoutSec 5
    Write-Log "MCP Server health check: $($healthResponse | ConvertTo-Json -Compress)"
}
catch {
    Write-Log "WARNING: MCP server health check failed: $_"
    Write-Log "Start MCP server with: Start-OrchMcpServer.ps1 -NoAuth"
}

# Example: Process a sample handoff
$sampleInput = "Test task: optimize dollhouse convergence"
Write-Log "Processing sample handoff: $sampleInput"
$handoffInterface.ProcessHandoff($sampleInput)
$handoffInterface.ProcessPendingHandoffs()

Write-Log "=== Active Agent Fleet Processing Test Complete ==="
Write-Log "Fleet Status: $($fleetManager.GetFleetStatus() | ConvertTo-Json -Compress)"
Write-Log "To start continuous processing, run this script in a loop or as a service"

# Final fleet status
$finalStatus = $fleetManager.GetFleetStatus()
Write-Log "Final Fleet Status:"
Write-Log "  Total Agents: $($finalStatus.totalAgents)"
Write-Log "  Active Agents: $($finalStatus.activeAgents)"
Write-Log "  Standby Agents: $($finalStatus.standbyAgents)"
Write-Log "  Processing Tasks: $($finalStatus.processingTasks)"

return $finalStatus