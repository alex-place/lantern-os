// Lantern OS Windsurf Developer JavaScript
// Generated: 2026-05-28

class WindsurfDev {
  constructor() {
    this.currentFile = 'main.py';
    this.aiContext = {
      repo: 'lantern-os',
      currentFile: 'apps/lantern-garage/server.js',
      ragSystem: 'active',
      userRole: 'developer'
    };
    this.chatHistory = [];
    this.init();
  }

  init() {
    this.setupEventListeners();
    this.setupKeyboardShortcuts();
    this.setupAIChat();
    this.setupCodeEditor();
    this.setupCommandPalette();
    this.startAIContextUpdates();
  }

  setupEventListeners() {
    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        if (!e.target.classList.contains('add-tab')) {
          this.switchTab(e.target.dataset.file);
        }
      });
    });

    // Action buttons
    document.getElementById('run-code')?.addEventListener('click', () => this.runCode());
    document.getElementById('ai-assist')?.addEventListener('click', () => this.openAIChat());
    document.getElementById('dev-tools')?.addEventListener('click', () => this.openDevTools());

    // Quick actions
    document.querySelectorAll('.quick-action').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.handleQuickAction(e.target.dataset.action);
      });
    });

    // Chat input
    const chatInput = document.getElementById('chat-input');
    chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendChatMessage();
      }
    });

    // Send button
    document.getElementById('send-btn')?.addEventListener('click', () => this.sendChatMessage());

    // Command palette
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        this.toggleCommandPalette();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        this.openAIChat();
      }
    });
  }

  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+Enter - Run code
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.runCode();
      }
      // Ctrl+S - Save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        this.saveFile();
      }
      // Ctrl+K - AI assist
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        this.openAIChat();
      }
      // Ctrl+P - Command palette
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        this.toggleCommandPalette();
      }
      // Escape - Close modals
      if (e.key === 'Escape') {
        this.closeModals();
      }
    });
  }

  setupAIChat() {
    // AI context updates
    this.updateAIContext();

    // Process commands
    const chatInput = document.getElementById('chat-input');
    chatInput?.addEventListener('input', (e) => {
      if (e.target.value.startsWith('/')) {
        this.handleCommand(e.target.value);
      }
    });
  }

  setupCodeEditor() {
    const editor = document.getElementById('code-editor');
    editor?.addEventListener('keydown', (e) => {
      // Handle Tab key for indentation
      if (e.key === 'Tab') {
        e.preventDefault();
        this.insertIndentation();
      }
      // Auto-closing brackets
      if (e.key === '(') {
        e.preventDefault();
        this.insertAround('(', ')');
      }
      if (e.key === '[') {
        e.preventDefault();
        this.insertAround('[', ']');
      }
      if (e.key === '{') {
        e.preventDefault();
        this.insertAround('{', '}');
      }
    });

    // AI suggestions on pause
    let typingTimer;
    editor?.addEventListener('input', () => {
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        this.showAISuggestion();
      }, 1000);
    });
  }

  setupCommandPalette() {
    const modal = document.getElementById('command-palette');
    const commandInput = modal?.querySelector('.command-input');
    
    // Command execution
    document.querySelectorAll('.command-item').forEach(item => {
      item.addEventListener('click', () => {
        this.executeCommand(item.dataset.command);
        this.closeModals();
      });
    });

    // Filter commands
    commandInput?.addEventListener('input', (e) => {
      this.filterCommands(e.target.value);
    });

    // Close on outside click
    modal?.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.closeModals();
      }
    });
  }

  switchTab(fileName) {
    // Update active tab
    document.querySelectorAll('.tab').forEach(tab => {
      tab.classList.remove('active');
      if (tab.dataset.file === fileName) {
        tab.classList.add('active');
      }
    });

    // Update current file context
    this.currentFile = fileName;
    this.aiContext.currentFile = fileName;
    this.updateAIContext();

    // Update breadcrumbs
    this.updateBreadcrumbs(fileName);

    // In a real implementation, this would load the actual file content
    this.loadFileContent(fileName);
  }

  loadFileContent(fileName) {
    const editor = document.getElementById('code-editor');
    if (!editor) return;

    // In a real implementation, this would fetch the actual file content
    // For now, we'll simulate different content based on file type
    let content = '';
    
    if (fileName.endsWith('.py')) {
      content = `<pre><code><span class="keyword">import</span> os
<span class="keyword">from</span> pathlib <span class="keyword">import</span> Path

<span class="keyword">def</span> <span class="function">main</span>():
    repo_root = Path(__file__).parent.parent
    print(f<span class="string">"Working in: {repo_root}"</span>)
    
    <span class="keyword">if</span> __name__ == <span class="string">"__main__"</span>:
        <span class="function">main</span>()</code></pre>`;
    } else if (fileName.endsWith('.js')) {
      content = `<pre><code><span class="keyword">const</span> http = <span class="module">require</span>(<span class="string">"http"</span>);
<span class="keyword">const</span> fs = <span class="module">require</span>(<span class="string">"fs"</span>);

<span class="keyword">const</span> server = http.<span class="function">createServer</span>((req, res) => {
    res.<span class="function">writeHead</span>(<span class="number">200</span>);
    res.<span class="function">end</span>(<span class="string">"Hello from Lantern OS!"</span>);
});

server.<span class="function">listen</span>(<span class="number">4177</span>);</code></pre>`;
    } else if (fileName.endsWith('.md')) {
      content = `<pre><code># Lantern OS Windsurf Developer

## Getting Started

This is the Windsurf-inspired developer interface for Lantern OS.

## Features

- AI-powered code assistance
- Real-time code analysis
- RAG-integrated context
- Developer productivity tools</code></pre>`;
    }

    editor.innerHTML = content;
  }

  updateBreadcrumbs(fileName) {
    const breadcrumbs = document.querySelector('.breadcrumbs');
    if (!breadcrumbs) return;

    const path = fileName.includes('/') ? fileName.split('/') : ['lantern-os', fileName];
    breadcrumbs.innerHTML = path.map((part, index) => 
      `<span class="breadcrumb ${index === path.length - 1 ? 'active' : ''}">${part}</span>`
    ).join('<span class="separator">›</span>');
  }

  updateAIContext() {
    const contextItems = document.querySelectorAll('.context-text');
    if (contextItems.length >= 2) {
      contextItems[0].textContent = `Current file: ${this.aiContext.currentFile}`;
      contextItems[1].textContent = `RAG system: ${this.aiContext.ragSystem}`;
    }
  }

  startAIContextUpdates() {
    // Update context periodically
    setInterval(() => {
      this.updateAIContext();
    }, 5000);
  }

  handleQuickAction(action) {
    const actions = {
      'explain': () => this.explainCode(),
      'debug': () => this.debugCode(),
      'optimize': () => this.optimizeCode(),
      'test': () => this.generateTests()
    };

    if (actions[action]) {
      actions[action]();
    }
  }

  async sendChatMessage() {
    const input = document.getElementById('chat-input');
    const message = input?.value.trim();
    if (!message) return;

    // Add user message
    this.addChatMessage(message, 'user');
    
    // Clear input
    input.value = '';

    // Generate AI response
    const response = await this.generateAIResponse(message);
    this.addChatMessage(response, 'ai');
  }

  addChatMessage(content, sender) {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}`;
    messageDiv.innerHTML = `
      <div class="message-avatar ${sender}">${sender === 'user' ? '👤' : '🤖'}</div>
      <div class="message-content">
        <p>${this.formatMessage(content)}</p>
      </div>
    `;
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    this.chatHistory.push({ sender, content, timestamp: new Date() });
  }

  formatMessage(message) {
    // Basic markdown-like formatting
    return message
      .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }

  async generateAIResponse(message) {
    // Simulate AI response with context awareness
    const responses = {
      'explain': `I can explain this code. The server.js file creates an HTTP server that serves files from the Lantern OS repository. It uses the 'http' and 'fs' modules to handle requests and read files. Would you like me to explain any specific part in detail?`,
      'debug': `I notice a potential issue: the error handling could be more robust. The current implementation doesn't handle file reading errors. Consider adding try-catch blocks around the fs.readFileSync call. Would you like me to show you an improved version?`,
      'optimize': `I can suggest a few optimizations:\n\n1. Add caching for frequently accessed files\n2. Implement proper MIME type detection\n3. Add compression support for text files\n4. Consider using streaming for large files\n\nWould you like me to implement any of these?`,
      'test': `I can generate comprehensive tests for this code. Here's a starting point:\n\n\`\`\`javascript\n// Server test example\ndescribe('HTTP Server', () => {\n  it('should respond with 200 for existing files', () => {\n    // Test implementation\n  });\n});\n\`\`\`\nWould you like me to expand the test suite?`,
      'default': `I understand you're asking about "${message}". Based on the current context of the Lantern OS repository and the server.js file you're working on, I can help you with:\n\n• Code explanations and debugging\n• Performance optimization suggestions\n• Test generation\n• RAG system integration\n\nWhat specific aspect would you like me to focus on?`
    };

    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Determine response type based on message content
    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes('explain') || lowerMessage.includes('what does')) {
      return responses['explain'];
    } else if (lowerMessage.includes('debug') || lowerMessage.includes('error') || lowerMessage.includes('bug')) {
      return responses['debug'];
    } else if (lowerMessage.includes('optimize') || lowerMessage.includes('improve') || lowerMessage.includes('faster')) {
      return responses['optimize'];
    } else if (lowerMessage.includes('test') || lowerMessage.includes('testing') || lowerMessage.includes('spec')) {
      return responses['test'];
    } else {
      return responses['default'];
    }
  }

  showAISuggestion() {
    const suggestion = document.getElementById('ai-suggestion');
    if (!suggestion) return;

    // Position suggestion near cursor
    const editor = document.getElementById('code-editor');
    const editorRect = editor?.getBoundingClientRect();
    
    if (editorRect) {
      suggestion.style.top = `${editorRect.top + 200}px`;
      suggestion.style.left = `${editorRect.right - 420}px`;
      suggestion.classList.add('active');
    }

    // Auto-hide after 10 seconds
    setTimeout(() => {
      suggestion.classList.remove('active');
    }, 10000);
  }

  insertAround(before, after) {
    const editor = document.getElementById('code-editor');
    if (!editor) return;

    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    
    const text = before + range.toString() + after;
    const textNode = document.createTextNode(text);
    
    range.deleteContents();
    range.insertNode(textNode);
    
    // Move cursor between the brackets
    range.setStart(textNode, before.length);
    range.setEnd(textNode, before.length);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  insertIndentation() {
    const editor = document.getElementById('code-editor');
    if (!editor) return;

    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    const textNode = document.createTextNode('    ');
    
    range.insertNode(textNode);
    
    // Move cursor after indentation
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  runCode() {
    console.log('Running code...');
    // In a real implementation, this would execute the code
    // For now, we'll show a status update
    this.showStatus('Code execution started...');
    setTimeout(() => this.showStatus('Code execution completed successfully'), 2000);
  }

  openAIChat() {
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
      chatInput.focus();
    }
  }

  openDevTools() {
    // In a real implementation, this would open browser dev tools
    console.log('Opening developer tools...');
  }

  saveFile() {
    console.log('Saving file...');
    this.showStatus('File saved successfully');
  }

  toggleCommandPalette() {
    const modal = document.getElementById('command-palette');
    if (modal) {
      modal.classList.toggle('active');
      const input = modal.querySelector('.command-input');
      if (input) input.focus();
    }
  }

  closeModals() {
    document.getElementById('command-palette')?.classList.remove('active');
    document.getElementById('ai-suggestion')?.classList.remove('active');
  }

  executeCommand(command) {
    const commands = {
      'ai-explain': () => this.handleQuickAction('explain'),
      'ai-debug': () => this.handleQuickAction('debug'),
      'format': () => this.formatCode(),
      'git-commit': () => this.gitCommit(),
      'lantern-rag': () => this.updateRAGContext()
    };

    if (commands[command]) {
      commands[command]();
    }
  }

  filterCommands(query) {
    const commandItems = document.querySelectorAll('.command-item');
    const lowerQuery = query.toLowerCase();

    commandItems.forEach(item => {
      const title = item.querySelector('.command-title')?.textContent.toLowerCase() || '';
      if (title.includes(lowerQuery)) {
        item.style.display = 'flex';
      } else {
        item.style.display = 'none';
      }
    });
  }

  handleCommand(input) {
    // Handle slash commands
    const command = input.substring(1).split(' ')[0];
    this.executeCommand(command);
  }

  showStatus(message) {
    // Show temporary status message
    const statusItem = document.querySelector('.status-center .status-item');
    if (statusItem) {
      const originalText = statusItem.textContent;
      statusItem.textContent = message;
      setTimeout(() => {
        statusItem.textContent = originalText;
      }, 3000);
    }
  }

  // Additional AI-powered features
  async explainCode() {
    await this.addChatMessage('Please explain the current code', 'user');
  }

  async debugCode() {
    await this.addChatMessage('Please debug the current code for potential issues', 'user');
  }

  async optimizeCode() {
    await this.addChatMessage('Please suggest optimizations for the current code', 'user');
  }

  async generateTests() {
    await this.addChatMessage('Please generate tests for the current code', 'user');
  }

  formatCode() {
    this.showStatus('Code formatted successfully');
  }

  gitCommit() {
    this.showStatus('Git commit initiated...');
  }

  updateRAGContext() {
    this.showStatus('RAG context updating...');
  }
}

// Initialize Windsurf Developer
document.addEventListener('DOMContentLoaded', () => {
  window.windsurfDev = new WindsurfDev();
});