---
name: windsurf-dev
description: Use the Windsurf-inspired AI-powered developer interface for Lantern OS development with integrated RAG context, real-time code assistance, and developer productivity tools. Provides seamless integration between code editing and AI assistance with full Lantern OS awareness.
---

# Windsurf Developer Experience

Use this skill when working on Lantern OS code development with AI-powered assistance, real-time code analysis, and RAG-integrated context.

## When to Use

Use this skill for:
- AI-powered code editing and development
- Real-time code assistance with Lantern OS context
- Debugging with RAG-aware AI support
- Code optimization and performance analysis
- Test generation for Lantern OS components
- Repository navigation and exploration
- Integration with Lantern OS deployment workflows

## Core Components

- **Windsurf Developer Interface**: `surfaces/windsurf-dev/`
- **AI Chat Integration**: Context-aware AI assistance
- **Code Editor**: Full-featured editor with syntax highlighting
- **Command Palette**: Quick access to Lantern OS commands
- **RAG System Integration**: Full Lantern OS context awareness

## Quick Start

### Open Windsurf Developer

```powershell
# Navigate to the developer interface
cd surfaces/windsurf-dev

# Open the interface in your browser
# Or use the integrated server if available
```

### Using AI Assistance

1. Open the Windsurf Developer interface
2. Navigate to the file you want to work on
3. Use Ctrl+K to open AI chat, or use quick action buttons
4. Ask questions about your code or use quick actions:
   - "Explain" - Get code explanation
   - "Debug" - Debug your code
   - "Optimize" - Optimize code performance
   - "Test" - Generate tests

### Keyboard Shortcuts

- **Ctrl+Enter**: Run current code
- **Ctrl+K**: Open AI chat
- **Ctrl+P**: Open command palette
- **Ctrl+S**: Save file
- **Escape**: Close modals

## Integration Points

### Lantern OS RAG System

The Windsurf Developer has full access to:
- Lantern OS documentation and manifests
- Repository structure and conventions
- Deployment scripts and configurations
- User profiles and access controls
- RAG dollhouse with project context

### Development Workflows

**Convergence Loop Integration:**
```powershell
# Use Windsurf Developer to edit convergence scripts
# Get AI assistance with script improvements
# Run scripts directly from the interface
# View real-time results and AI analysis
```

**Deployment Support:**
```powershell
# Access deployment scripts through file explorer
- Use AI to understand deployment processes
- Get AI assistance with deployment debugging
- Monitor deployment status in real-time
```

**Repository Management:**
```powershell
# Navigate Lantern OS repository structure
- Use AI to understand file relationships
- Get context-aware code suggestions
- Integrate with Git operations
```

## AI Capabilities

### Code Analysis

The AI can analyze:
- Code structure and patterns
- Potential bugs and issues
- Performance bottlenecks
- Security vulnerabilities
- Best practice violations

### Code Assistance

The AI provides:
- Code explanations with Lantern OS context
- Debugging suggestions and fixes
- Performance optimization recommendations
- Test generation and examples
- Refactoring suggestions

### RAG Integration

The AI understands:
- Lantern OS architecture and conventions
- Safety boundaries and access controls
- Repository structure and relationships
- Deployment workflows and scripts
- User profiles and access patterns

## Developer Tools

### Quick Actions

- **Explain Code**: Instant AI code explanations
- **Debug**: AI debugging assistance
- **Optimize**: Performance optimization
- **Generate Tests**: Automated test creation

### Command Palette

Quick access to:
- AI commands (explain, debug, optimize, test)
- Code formatting and linting
- Git operations
- RAG context updates
- Deployment tools

### File Operations

- Multi-file editing
- File search and navigation
- Git integration
- File history comparison
- Batch operations

## Safety and Access Control

### Developer Safety

- Respects Lantern OS safety boundaries
- No destructive operations without confirmation
- Read-only repository operations by default
- Secure credential handling
- Audit logging for AI interactions

### Access Requirements

- Developer role required
- Read access to Lantern OS repository
- RAG system access
- AI service availability

## Best Practices

### AI Interaction

1. Provide clear, specific questions
2. Include relevant code context
3. Review AI suggestions critically
4. Understand AI limitations
5. Verify suggestions before applying

### Code Quality

1. Use AI for code review and suggestions
2. Follow Lantern OS coding conventions
3. Write tests with AI assistance
4. Document changes with AI help
5. Maintain consistent style

### Workflow Integration

1. Integrate with existing development workflows
2. Use RAG context for Lantern OS patterns
3. Follow safety boundaries strictly
4. Test changes thoroughly
5. Use version control effectively

## Troubleshooting

### AI Not Responding

1. Check AI connection status
2. Verify RAG context is loaded
3. Check network connectivity
4. Restart AI service if needed
5. Check developer role permissions

### Performance Issues

1. Reduce open file count
2. Clear AI context cache
3. Check system resources
4. Disable advanced features if needed
5. Optimize RAG query complexity

### File Access Issues

1. Verify file permissions
2. Check repository status
3. Ensure file is not locked
4. Check for syntax errors
5. Verify developer role access

## Advanced Features

### Custom AI Actions

Add custom quick actions:
```javascript
// Add to windsurf-dev.js
addQuickAction('deploy', () => {
  // Custom deployment action
});
```

### Extended RAG Context

Access additional RAG sources:
- Lantern OS documentation
- Repository manifests
- Deployment configurations
- User profiles and access controls
- Historical development patterns

### Workflow Automation

Create custom developer workflows:
- Automated testing sequences
- Deployment automation
- Documentation generation
- Code review automation
- Performance monitoring

## Learning Resources

### Getting Started

1. Read the developer experience documentation
2. Open the Windsurf Developer interface
3. Try basic AI assistance features
4. Explore keyboard shortcuts
5. Practice with sample code

### Advanced Usage

1. Use command palette for complex tasks
2. Create custom quick actions
3. Integrate with existing workflows
4. Leverage full RAG context
5. Optimize for your development style

## Integration Examples

### Convergence Loop Development

```javascript
// Edit convergence loop scripts with AI assistance
// Get explanations of complex logic
// Debug script issues with AI help
// Generate tests for loop steps
// Integrate with existing workflow
```

### Deployment Script Development

```javascript
// Create deployment scripts with AI assistance
- Understand deployment patterns
- Debug deployment issues
- Optimize deployment performance
- Generate deployment tests
- Integrate with Lantern Garage
```

### RAG System Development

```javascript
// Work on RAG system with AI assistance
- Understand RAG architecture
- Debug RAG integration issues
- Optimize RAG performance
- Test RAG functionality
- Update RAG documentation
```

## Boundaries

### What This Skill Does

- Provide AI-powered code development assistance
- Integrate with Lantern OS RAG system
- Support developer productivity workflows
- Maintain Lantern OS safety boundaries
- Provide context-aware code analysis

### What This Skill Does Not Do

- Replace human code review
- Make architectural decisions without approval
- Modify deployment configurations automatically
- Access restricted repository areas
- Bypass safety boundaries or access controls

## Conclusion

The Windsurf Developer skill provides a powerful AI-enhanced development experience specifically tailored for Lantern OS. It combines modern AI assistance with deep Lantern OS context awareness, making development more efficient while maintaining the security and safety standards that Lantern OS requires.