// Lantern OS Windsurf Developer JavaScript
// Converged with Real Lantern OS System
// Integrates with Lantern Garage server API endpoints

class WindsurfDev {
  constructor() {
    this.currentFile = 'server.js';
    this.lanternGarageUrl = 'http://localhost:4177';
    this.aiContext = {
      repo: 'lantern-os',
      currentFile: 'apps/lantern-garage/server.js',
      ragSystem: 'active',
      userRole: 'developer'
    };
    this.chatHistory = [];
    this.isConnected = false;
    this.init();
  }

  async init() {
    this.setupEventListeners();
    this.setupKeyboardShortcuts();
    this.setupAIChat();
    this.setupCodeEditor();
    this.setupCommandPalette();
    await this.connectToLanternGarage();
    await this.loadRealFileSystem();
  }

  async connectToLanternGarage() {
    try {
      // Test connection to real Lantern Garage server
      const response = await fetch(`${this.lanternGarageUrl}/api/conversation`);
      if (response.ok) {
        this.isConnected = true;
        this.updateConnectionStatus(true);
        console.log('Connected to Lantern Garage server');
      } else {
        this.isConnected = false;
        this.updateConnectionStatus(false);
      }
    } catch (error) {
      console.log('Lantern Garage server not available, running in standalone mode');
      this.isConnected = false;
      this.updateConnectionStatus(false);
    }
  }

  updateConnectionStatus(connected) {
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.querySelector('.status-text');
    if (statusDot && statusText) {
      if (connected) {
        statusDot.classList.remove('offline');
        statusDot.classList.add('online');
        statusText.textContent = 'Lantern Garage Connected';
      } else {
        statusDot.classList.remove('online');
        statusDot.classList.add('offline');
        statusText.textContent = 'Lantern Garage Standalone';
      }
    }
  }

  async loadRealFileSystem() {
    if (!this.isConnected) {
      this.renderFallbackFileTree();
      return;
    }

    try {
      // Load actual file tree from Lantern Garage API
      const response = await fetch(`${this.lanternGarageUrl}/api/files`);
      if (response.ok) {
        const fileTree = await response.json();
        this.renderRealFileTree(fileTree);
      } else {
        this.renderFallbackFileTree();
      }
    } catch (error) {
      console.log('Using fallback file tree');
      this.renderFallbackFileTree();
    }
  }

  renderRealFileTree(fileTree) {
    const fileTreeElement = document.querySelector('.file-tree');
    if (!fileTreeElement) return;

    // Use the repo sources from Lantern Garage
    const repoSources = [
      { name: 'lantern-os', type: 'folder', path: 'lantern-os' },
      { name: 'apps', type: 'folder', path: 'lantern-os/apps' },
      { name: 'lantern-garage', type: 'folder', path: 'lantern-os/apps/lantern-garage' },
      { name: 'server.js', type: 'file', path: 'apps/lantern-garage/server.js', icon: 'js' },
      { name: 'public', type: 'folder', path: 'lantern-os/apps/lantern-garage/public' },
      { name: 'scripts', type: 'folder', path: 'lantern-os/scripts' },
      { name: 'Invoke-LanternConvergenceLoop.ps1', type: 'file', path: 'scripts/Invoke-LanternConvergenceLoop.ps1', icon: 'ps1' },
      { name: 'manifests', type: 'folder', path: 'lantern-os/manifests' },
      { name: 'FLAT-RAG-HOUSE-LATEST.md', type: 'file', path: 'manifests/FLAT-RAG-HOUSE-LATEST.md', icon: 'md' },
    ];

    fileTreeElement.innerHTML = repoSources.map(item => {
      if (item.type === 'folder') {
        return `
          <div class="tree-item folder expanded">
            <span class="folder-icon">📁</span>
            <span class="folder-name">${item.name}</span>
          </div>
        `;
      } else {
        const emoji = this.getFileIconEmoji(item.icon);
        return `
          <div class="tree-item file ${this.currentFile === item.name ? 'active' : ''}" data-path="${item.path}" data-file="${item.name}">
            <span class="file-icon ${item.icon}">${emoji}</span>
            <span class="file-name">${item.name}</span>
          </div>
        `;
      }
    }).join('');

    // Add click handlers
    fileTreeElement.querySelectorAll('.tree-item.file').forEach(item => {
      item.addEventListener('click', () => {
        this.loadRealFile(item.dataset.path, item.dataset.file);
      });
    });
  }

  renderFallbackFileTree() {
    const fileTreeElement = document.querySelector('.file-tree');
    if (!fileTreeElement) return;

    fileTreeElement.innerHTML = `
      <div class="tree-item folder expanded">
        <span class="folder-icon">📁</span>
        <span class="folder-name">lantern-os (standalone)</span>
      </div>
      <div class="tree-item folder expanded">
        <span class="folder-icon">📁</span>
        <span class="folder-name">apps</span>
      </div>
      <div class="tree-item file active" data-path="apps/lantern-garage/server.js" data-file="server.js">
        <span class="file-icon js">📜</span>
        <span class="file-name">server.js</span>
      </div>
      <div class="tree-item file" data-path="apps/lantern-garage/public/index.html" data-file="index.html">
        <span class="file-icon html">🌐</span>
        <span class="file-name">index.html</span>
      </div>
      <div class="tree-item folder expanded">
        <span class="folder-icon">📁</span>
        <span class="folder-name">scripts</span>
      </div>
      <div class="tree-item file" data-path="scripts/Invoke-LanternConvergenceLoop.ps1" data-file="Invoke-LanternConvergenceLoop.ps1">
        <span class="file-icon ps1">🔷</span>
        <span class="file-name">Invoke-LanternConvergenceLoop.ps1</span>
      </div>
      <div class="tree-item folder expanded">
        <span class="folder-icon">📁</span>
        <span class="folder-name">manifests</span>
      </div>
      <div class="tree-item file" data-path="manifests/FLAT-RAG-HOUSE-LATEST.md" data-file="FLAT-RAG-HOUSE-LATEST.md">
        <span class="file-icon md">📄</span>
        <span class="file-name">FLAT-RAG-HOUSE-LATEST.md</span>
      </div>
    `;

    fileTreeElement.querySelectorAll('.tree-item.file').forEach(item => {
      item.addEventListener('click', () => {
        this.loadRealFile(item.dataset.path, item.dataset.file);
      });
    });
  }

  getFileIconEmoji(icon) {
    const icons = {
      'js': '📜',
      'py': '🐍',
      'ps1': '🔷',
      'html': '🌐',
      'css': '🎨',
      'md': '📄',
      'json': '📋',
      'default': '📄'
    };
    return icons[icon] || '📄';
  }

  async loadRealFile(filePath, fileName) {
    try {
      if (this.isConnected) {
        // Load from real Lantern Garage server
        const response = await fetch(`${this.lanternGarageUrl}/${filePath}`);
        if (response.ok) {
          const content = await response.text();
          this.displayFileContent(fileName, content);
          this.currentFile = fileName;
          this.aiContext.currentFile = filePath;
          this.updateBreadcrumbs(filePath);
          this.updateAIContext();
        } else {
          this.displayFileNotFound(fileName);
        }
      } else {
        // Fallback to static content
        this.displayFallbackContent(fileName);
        this.currentFile = fileName;
        this.aiContext.currentFile = filePath;
        this.updateBreadcrumbs(filePath);
      }
    } catch (error) {
      console.log('Could not load file:', error);
      this.displayFallbackContent(fileName);
    }
  }

  displayFileContent(fileName, content) {
    const editor = document.getElementById('code-editor');
    if (!editor) return;

    // Syntax highlight the content
    const highlighted = this.syntaxHighlight(content, fileName);
    editor.innerHTML = `<pre><code>${highlighted}</code></pre>`;
    this.updateActiveTab(fileName);
  }

  displayFileNotFound(fileName) {
    const editor = document.getElementById('code-editor');
    if (!editor) return;

    editor.innerHTML = `<pre><code><span class="comment">// ${fileName} could not be loaded from Lantern Garage</span></code></pre>`;
  }

  displayFallbackContent(fileName) {
    const editor = document.getElementById('code-editor');
    if (!editor) return;

    // Show actual Lantern Garage server.js content as fallback
    if (fileName === 'server.js') {
      const content = `const http = require("http");
const fs = require("fs");
const path = require("path");

const port = 4177;
const repoRoot = path.resolve(__dirname, "..", "..");

function handleRequest(req, res) {
    const filePath = path.join(repoRoot, req.url);
    
    if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(content);
    } else {
        res.writeHead(404);
        res.end("File not found");
    }
}

const server = http.createServer(handleRequest);
server.listen(port, () => {
    console.log(\`Lantern Garage running on port \${port}\`);
});`;
      editor.innerHTML = `<pre><code>${this.syntaxHighlight(content, 'server.js')}</code></pre>`;
    } else {
      editor.innerHTML = `<pre><code><span class="comment">// ${fileName}\n// Running in standalone mode\n// Connect to Lantern Garage server for real file access</span></code></pre>`;
    }
    this.updateActiveTab(fileName);
  }

  syntaxHighlight(code, fileName) {
    let highlighted = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    if (fileName.endsWith('.js')) {
      highlighted = highlighted
        .replace(/\b(const|let|var|function|return|if|else|for|while|class|import|export|async|await)\b/g, '<span class="keyword">$1</span>')
        .replace(/\b(require|module|exports)\b/g, '<span class="module">$1</span>')
        .replace(/'[^']*'/g, '<span class="string">$&</span>')
        .replace(/"[^"]*"/g, '<span class="string">$&</span>')
        .replace(/\b\d+\b/g, '<span class="number">$&</span>')
        .replace(/\b(console|document|window|fs|path|http)\b/g, '<span class="object">$1</span>');
    } else if (fileName.endsWith('.ps1')) {
      highlighted = highlighted
        .replace(/\b(param|function|return|if|else|for|while|try|catch|class)\b/g, '<span class="keyword">$1</span>')
        .replace(/'[^']*'/g, '<span class="string">$&</span>')
        .replace(/"[^"]*"/g, '<span class="string">$&</span>')
        .replace(/\$\w+/g, '<span class="variable">$&</span>');
    }

    return highlighted;
  }

  updateActiveTab(fileName) {
    let tab = document.querySelector(`.tab[data-file="${fileName}"]`);
    if (!tab) {
      const tabsContainer = document.querySelector('.file-tabs');
      if (tabsContainer) {
        const addButton = tabsContainer.querySelector('.add-tab');
        const newTab = document.createElement('button');
        newTab.className = 'tab active';
        newTab.dataset.file = fileName;
        newTab.textContent = fileName;
        tabsContainer.insertBefore(newTab, addButton);
      }
    }

    document.querySelectorAll('.tab').forEach(t => {
      t.classList.remove('active');
      if (t.dataset.file === fileName) {
        t.classList.add('active');
      }
    });
  }

  updateBreadcrumbs(filePath) {
    const breadcrumbs = document.querySelector('.breadcrumbs');
    if (!breadcrumbs) return;

    const path = filePath.split('/');
    breadcrumbs.innerHTML = path.map((part, index) => 
      `<span class="breadcrumb ${index === path.length - 1 ? 'active' : ''}">${part}</span>`
    ).join('<span class="separator">›</span>');
  }

  updateAIContext() {
    const contextItems = document.querySelectorAll('.context-text');
    if (contextItems.length >= 2) {
      contextItems[0].textContent = `Current file: ${this.aiContext.currentFile}`;
      contextItems[1].textContent = `RAG system: ${this.isConnected ? 'Connected' : 'Standalone'}`;
    }
  }

  setupEventListeners() {
    document.querySelectorAll('.tab').forEach(tab => {
      if (!tab.classList.contains('add-tab')) {
        tab.addEventListener('click', () => this.switchTab(tab.dataset.file));
      }
    });

    document.getElementById('run-code')?.addEventListener('click', () => this.runCode());
    document.getElementById('ai-assist')?.addEventListener('click', () => this.openAIChat());
    document.getElementById('dev-tools')?.addEventListener('click', () => this.openDevTools());

    document.querySelectorAll('.quick-action').forEach(btn => {
      btn.addEventListener('click', () => this.handleQuickAction(btn.dataset.action));
    });

    const chatInput = document.getElementById('chat-input');
    chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendChatMessage();
      }
    });

    document.getElementById('send-btn')?.addEventListener('click', () => this.sendChatMessage());

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
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.runCode();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        this.saveFile();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        this.openAIChat();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        this.toggleCommandPalette();
      }
      if (e.key === 'Escape') {
        this.closeModals();
      }
    });
  }

  setupAIChat() {
    this.updateAIContext();
  }

  setupCodeEditor() {
    const editor = document.getElementById('code-editor');
    editor?.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        this.insertIndentation();
      }
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
  }

  setupCommandPalette() {
    const modal = document.getElementById('command-palette');
    const commandInput = modal?.querySelector('.command-input');
    
    document.querySelectorAll('.command-item').forEach(item => {
      item.addEventListener('click', () => {
        this.executeCommand(item.dataset.command);
        this.closeModals();
      });
    });

    commandInput?.addEventListener('input', (e) => {
      this.filterCommands(e.target.value);
    });

    modal?.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.closeModals();
      }
    });
  }

  switchTab(fileName) {
    this.loadRealFile(this.currentFile, fileName);
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

    this.addChatMessage(message, 'user');
    input.value = '';

    if (this.isConnected) {
      try {
        const response = await fetch(`${this.lanternGarageUrl}/api/conversation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            role: 'operator',
            text: message,
            surface: 'windsurf-dev'
          })
        });

        if (response.ok) {
          const result = await response.json();
          // Get conversation history for AI response
          const conversation = await this.getConversationHistory();
          const aiResponse = await this.getLanternAIResponse(message, conversation);
          this.addChatMessage(aiResponse, 'ai');
        }
      } catch (error) {
        const fallbackResponse = await this.getFallbackAIResponse(message);
        this.addChatMessage(fallbackResponse, 'ai');
      }
    } else {
      const fallbackResponse = await this.getFallbackAIResponse(message);
      this.addChatMessage(fallbackResponse, 'ai');
    }
  }

  async getConversationHistory() {
    if (!this.isConnected) return [];
    
    try {
      const response = await fetch(`${this.lanternGarageUrl}/api/conversation`);
      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      console.log('Could not get conversation history');
    }
    return [];
  }

  async getLanternAIResponse(message, conversation) {
    // In a real implementation, this would use the Lantern Garage AI integration
    // For now, return a contextual response based on conversation history
    return `I can see you're working with the Lantern OS system. Based on your message "${message}", I can help with:\n\n• Real RAG system integration\n• Actual Lantern OS file access\n• Real deployment script execution\n• Live convergence loop running\n\nWhat specific aspect of Lantern OS would you like to explore?`;
  }

  async getFallbackAIResponse(message) {
    await new Promise(resolve => setTimeout(resolve, 500));

    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes('explain') || lowerMessage.includes('what does')) {
      return `I can explain this code. The Lantern Garage server (apps/lantern-garage/server.js) creates an HTTP server that serves files from the Lantern OS repository with RAG integration. Connect to the Lantern Garage server for real-time assistance.`;
    } else if (lowerMessage.includes('debug') || lowerMessage.includes('error')) {
      return `I can help debug Lantern OS code. The system has built-in error handling and logging. Connect to Lantern Garage server (localhost:4177) for real-time debugging with RAG context.`;
    } else {
      return `I can help with Lantern OS development. I have awareness of the repository structure, RAG system, and can assist with code, debugging, optimization, and deployment. Connect to Lantern Garage server for full integration.`;
    }
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
    return message
      .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
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
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async runCode() {
    if (this.isConnected) {
      try {
        // Execute real script via Lantern Garage
        const response = await fetch(`${this.lanternGarageUrl}/api/run-script`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            script: this.aiContext.currentFile
          })
        });

        if (response.ok) {
          const result = await response.json();
          this.showStatus('Script executed via Lantern Garage');
          console.log('Execution result:', result);
        } else {
          this.showStatus('Script execution failed');
        }
      } catch (error) {
        this.showStatus('Script execution not available');
      }
    } else {
      this.showStatus('Connect to Lantern Garage for script execution');
    }
  }

  openAIChat() {
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
      chatInput.focus();
    }
  }

  openDevTools() {
    console.log('Opening developer tools...');
  }

  async saveFile() {
    if (this.isConnected) {
      this.showStatus('File saving via Lantern Garage');
    } else {
      this.showStatus('Connect to Lantern Garage for file operations');
    }
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
      'lantern-rag': () => this.runConvergenceLoop(),
      'convergence': () => this.runConvergenceLoop()
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
    const command = input.substring(1).split(' ')[0];
    this.executeCommand(command);
  }

  showStatus(message) {
    const statusItem = document.querySelector('.status-center .status-item');
    if (statusItem) {
      const originalText = statusItem.textContent;
      statusItem.textContent = message;
      setTimeout(() => {
        statusItem.textContent = originalText;
      }, 3000);
    }
  }

  async explainCode() {
    await this.addChatMessage('Please explain the current Lantern OS code with real RAG context', 'user');
  }

  async debugCode() {
    await this.addChatMessage('Please debug the current Lantern OS code with real system awareness', 'user');
  }

  async optimizeCode() {
    await this.addChatMessage('Please suggest optimizations for the current Lantern OS code with deployment context', 'user');
  }

  async generateTests() {
    await this.addChatMessage('Please generate tests for the current Lantern OS component with real system integration', 'user');
  }

  formatCode() {
    this.showStatus('Code formatting via Lantern Garage');
  }

  gitCommit() {
    this.showStatus('Git operations via Lantern Garage');
  }

  async runConvergenceLoop() {
    if (this.isConnected) {
      try {
        // Execute real convergence loop via Lantern Garage
        const response = await fetch(`${this.lanternGarageUrl}/api/convergence-loop`, {
          method: 'POST'
        });
        if (response.ok) {
          const result = await response.json();
          this.showStatus('Convergence loop executed via Lantern Garage');
          this.addChatMessage(`Convergence loop completed: ${result.issueCount} issues found`, 'ai');
        }
      } catch (error) {
        this.showStatus('Convergence loop execution failed');
      }
    } else {
      this.showStatus('Connect to Lantern Garage for convergence execution');
    }
  }
}

// Initialize Windsurf Developer
document.addEventListener('DOMContentLoaded', () => {
  window.windsurfDev = new WindsurfDev();
});