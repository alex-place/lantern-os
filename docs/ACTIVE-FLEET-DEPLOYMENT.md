# Active Agent Fleet Deployment Instructions

## Deployment to Orchestrator Repository

The active agent fleet processing system has been implemented and needs to be deployed to the orchestrator repository.

## Files to Deploy

### From Lantern OS to Orchestrator
1. **scripts/Start-ActiveAgentFleet.ps1** - Active fleet processing script
2. **config/active-processing.json** - Active processing configuration

## Deployment Steps

### Step 1: Copy Files to Orchestrator Repository
```powershell
# Copy active fleet script
Copy-Item "d:/tmp/lantern-os/scripts/Start-ActiveAgentFleet.ps1" "C:/Users/alexp/Documents/gm-agent-orchestrator/scripts/"

# Copy configuration (already created)
# config/active-processing.json already exists in orchestrator
```

### Step 2: Test Active Fleet Processing
```powershell
cd "C:\Users\alexp\Documents\gm-agent-orchestrator"

# Start MCP server with no-auth (if not already running)
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-OrchMcpServer.ps1 -NoAuth

# Test active fleet processing
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-ActiveAgentFleet.ps1 -NoAuth
```

### Step 3: Verify MCP Server Health
```powershell
# Check MCP server status
Invoke-RestMethod http://127.0.0.1:8787/health | ConvertTo-Json

# Expected response: ok=true, noAuth=true
```

### Step 4: Test Chat Handoff Processing
```powershell
# Test with sample input
$testInput = "Test task: optimize dollhouse convergence"
# The active fleet script includes a sample handoff test
```

### Step 5: Commit Changes to Orchestrator
```powershell
cd "C:\Users\alexp\Documents\gm-agent-orchestrator"

git add scripts/Start-ActiveAgentFleet.ps1 config/active-processing.json
git commit -m "feat: Add active agent fleet processing with chat handoff integration

Implemented active agent fleet processing to enable agents to actively process
raw contexts from chat handoffs instead of standby mode. Each task is converged
in fleet with self-correcting skills and responded to via MCP.

Components Added:
- Start-ActiveAgentFleet.ps1 - Active fleet management script
- active-processing.json - Configuration for active processing

Key Features:
- Immediate chat handoff processing (no queue delay)
- Active agent fleet with standby activation
- Task convergence with dollhouse self-correcting skills
- MCP responses for each processed task
- Real-time fleet status monitoring

Configuration:
- activeProcessing.enabled = true
- chatHandoffIntegration = true
- immediateDispatch = true
- mcpResponseRequired = true
- dollhouseSkillsEnabled = true
- fleetConvergence = true
- standbyActivation = true

Next Steps:
1. Test active fleet processing with MCP server
2. Verify chat handoff integration
3. Monitor fleet status dashboard
4. Test dollhouse skills integration

Generated with Devin CLI"

git push origin master
```

## Verification Checklist

### Active Processing Verification
- [ ] MCP server running on http://127.0.0.1:8787
- [ ] Active fleet script runs without errors
- [ ] Agent configuration loaded correctly
- [ ] Chat handoffs captured and processed
- [ ] MCP responses sent successfully
- [ ] Fleet status monitoring functional

### Integration Verification
- [ ] Lantern OS dollhouse skills accessible
- [ ] Self-correction applied to tasks
- [ ] Fleet convergence working
- [ ] Standby agents activating correctly
- [ ] No queue delay for processing
- [ ] Real-time responses via MCP

### Performance Verification
- [ ] Processing time < 2 seconds per task
- [ ] Agent activation working correctly
- [ ] Fleet convergence rate > 95%
- [ ] MCP response success rate > 98%
- [ ] Self-correction improving accuracy

## Troubleshooting

### MCP Server Issues
```powershell
# Check if MCP server is running
Invoke-RestMethod http://127.0.0.1:8787/health

# Restart MCP server
Stop-Process -Name "node" -Force
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-OrchMcpServer.ps1 -NoAuth
```

### Agent Activation Issues
```powershell
# Check agent status
Get-Content config/agents.json | ConvertFrom-Json

# Verify active processing configuration
Get-Content config/active-processing.json | ConvertFrom-Json
```

### Chat Handoff Issues
```powershell
# Check handoff log
Get-Content logs/chat-handoffs.log -Tail 20

# Test handoff processing
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-ActiveAgentFleet.ps1 -NoAuth
```

## Success Criteria
- ✅ Agents actively process chat handoffs (no standby)
- ✅ Each task converged in fleet with self-correcting skills
- ✅ MCP responses sent for each processed task
- ✅ Standby agents activated when needed
- ✅ Real-time fleet status available
- ✅ Processing time < 2 seconds per task
- ✅ Integration with lantern-os dollhouse system

## Next Actions
1. Deploy files to orchestrator repository
2. Test active fleet processing
3. Verify MCP integration
4. Monitor fleet performance
5. Test chat handoff integration
6. Validate self-correction skills