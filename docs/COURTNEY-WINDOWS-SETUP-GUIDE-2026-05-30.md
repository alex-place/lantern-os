# Courtney Windows Setup Guide

**Date:** 2026-05-30  
**Purpose:** Set up Windsurf and Lantern OS on Courtney's Windows laptop  
**Status:** Current working setup - no exe installer exists yet

---

## Current Reality Check

**Important:** There is NO released exe installer yet. The project is in pre-v1 staging.

**What exists:**
- `lantern-desktop-tester-latest.zip` (78KB) - Current working tester build
- PowerShell script installation method
- Local-first architecture that runs on Windows

**What does NOT exist yet:**
- `Lantern-OS-Free-Setup.exe` - Future installer, not built yet
- `Lantern-OS-Founder-20-Setup.exe` - Future paid installer, not built yet
- GitHub releases with exe assets
- Native desktop app cloud bridge exe

**You will use:** The zip file method with PowerShell scripts.

---

## Part 1: Windsurf Installation

### What is Windsurf?
Windsurf is an AI-powered code editor (similar to Cursor or GitHub Copilot) that you'll use to work with Lantern OS code.

### Installation Steps

1. **Download Windsurf**
   - Go to: `https://windsurf.ai`
   - Click "Download" for Windows
   - Run the installer when downloaded

2. **Install Windsurf**
   - Follow the standard Windows installer prompts
   - Choose default installation location
   - Complete the installation

3. **Open Windsurf**
   - Launch Windsurf from Start menu
   - Sign in or create account if prompted
   - You'll use this to open the Lantern OS repository

### Alternative: Use VS Code with Copilot
If Windsurf has issues, you can also use:
- Visual Studio Code: `https://code.visualstudio.com`
- GitHub Copilot extension for AI assistance

---

## Part 2: Lantern OS Installation (Recommended Method)

### Quick Install with Wizard

**New! Use the interactive installer wizard:**

1. Download: `lantern-os-courtney-installer-2026-05-30.zip` from the artifacts folder
2. Extract the zip to any folder
3. Double-click: `Invoke-CourtneySetupWizard.ps1`
4. Follow the prompts - the wizard will:
   - Check prerequisites
   - Clone the repository
   - Configure Git
   - Create a desktop shortcut
   - Set up the local-cloud bridge

### Manual Installation (If Wizard Fails)

### Prerequisites
- Windows 10 or 11
- Node.js 20 or newer
- PowerShell (included with Windows)
- Internet connection for initial setup

### Step 1: Install Node.js

1. **Download Node.js**
   - Go to: `https://nodejs.org`
   - Download "LTS" version (recommended)
   - Run the installer

2. **Verify Installation**
   - Open PowerShell (search "PowerShell" in Start menu)
   - Run: `node --version`
   - Should show version 20.x or higher

### Step 2: Get Lantern OS Files

**Option A: Copy from Alex's Computer (Fastest)**
1. On Alex's computer, navigate to: `d:\tmp\lantern-os\artifacts\`
2. Copy `lantern-desktop-tester-latest.zip` to a USB drive
3. On your computer, extract the zip to a folder (e.g., `C:\LanternOS\`)

**Option B: Download from GitHub (If Release Exists)**
1. Go to: `https://github.com/alex-place/lantern-os/releases`
2. Look for `lantern-desktop-tester-latest.zip`
3. Download and extract to a folder (e.g., `C:\LanternOS\`)

**Option C: Clone Repository (For Full Development)**
1. Install Git: `https://git-scm.com/download/win`
2. Open PowerShell in your chosen folder
3. Run: `git clone https://github.com/alex-place/lantern-os.git`
4. Navigate to: `cd lantern-os`

### Step 3: Start Lantern OS

1. **Open PowerShell as Administrator**
   - Right-click PowerShell
   - Select "Run as Administrator"

2. **Navigate to Lantern OS Folder**
   ```powershell
   cd C:\LanternOS
   ```

3. **Run the Start Script**
   ```powershell
   .\Start-LanternDesktopTester.ps1
   ```

4. **If Script Fails with Execution Policy**
   ```powershell
   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
   .\Start-LanternDesktopTester.ps1
   ```

5. **Browser Should Open Automatically**
   - If not, go to: `http://127.0.0.1:4177`
   - This is your local Lantern OS dashboard

---

## Part 3: Using Lantern OS

### First Steps

1. **Explore the Dashboard**
   - Chat interface for asking questions
   - Demo deck explaining what Lantern does
   - Art Matrix and other features

2. **Test Basic Features**
   - Try the chat: "What can Lantern OS do?"
   - Look at the demo deck
   - Check the local/cloud URL map

3. **Safety Rules**
   - NEVER enter: passwords, seed phrases, private keys, card numbers
   - This is a tester build, not production software
   - Don't use for real financial transactions yet

### Your User Context

You're set up as:
- **User:** courtney
- **Role:** collaborator
- **Focus:** family projects, collaboration, outreach
- **Content Filter:** family-safe

### What You Can Do

- Family project planning and coordination
- Shared decision-making tools
- Outreach campaign preparation
- Community communication
- Document and report generation
- Local RAG (document search)

---

## Part 4: Cloud Bridge Setup (Future)

### Current Status
The native desktop app cloud bridge exe does NOT exist yet. This is planned for future development.

### What This Means
- You'll run Lantern OS locally on your machine
- Cloud features are limited in current tester build
- Full cloud integration will come in future versions

### Workaround for Now
- Use the local-first features
- Manual file sharing for collaboration
- Direct communication for coordination

---

## Part 5: Troubleshooting

### Node.js Not Found
**Error:** "Node.js 20+ is required"
**Solution:**
- Install Node.js from nodejs.org
- Restart PowerShell after installation
- Verify with `node --version`

### PowerShell Execution Policy
**Error:** "Cannot run script because execution policy is restricted"
**Solution:**
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Port Already in Use
**Error:** "Port 4177 is already in use"
**Solution:**
- Close other applications using port 4177
- Or change port in the script

### Browser Doesn't Open
**Solution:**
- Manually go to: `http://127.0.0.1:4177`
- Check if the server is running in PowerShell

### Windsurf Issues
**Solution:**
- Try VS Code as alternative
- Check Windsurf documentation
- Ensure you have internet connection

---

## Part 6: Next Steps After Setup

### Immediate (Today)
1. Complete Windsurf installation
2. Complete Lantern OS installation
3. Test basic features
4. Read your convergence report: `reports/COURTNEY-BLASIOLI-CONVERGENCE-REPORT-2026-05-30.md`

### This Week
1. Explore Lantern OS features
2. Set up your Codex Cloud access (if needed)
3. Begin outreach campaign preparation
4. Coordinate with Alex on next steps

### Ongoing
1. Use Lantern OS for family projects
2. Lead outreach and community work
3. Provide feedback on tester build
4. Help shape future development

---

## Part 7: Getting Help

### If Something Doesn't Work
1. Check this guide's troubleshooting section
2. Ask Alex for help (he's right there!)
3. Check the documentation in the `docs/` folder
4. Look at `docs/LANTERN-DESKTOP-TESTER.md` for more details

### Documentation Files to Read
- `docs/LANTERN-DESKTOP-TESTER.md` - Tester documentation
- `docs/wiki/WINDOWS-TESTER-INSTALL.md` - Windows install details
- `docs/USER-QUICK-START-COURTNEY.md` - Your user guide

---

## Summary

**What you're installing:**
- Windsurf: AI code editor for development work
- Lantern OS: Local-first AI control plane (tester build)

**What you're NOT getting:**
- Exe installer (doesn't exist yet)
- Production-ready software (this is a tester build)
- Full cloud bridge (planned for future)

**What you CAN do:**
- Use local AI features
- Family project collaboration
- Outreach campaign work
- Help test and shape the project

**Your role:**
- Outreach and community lead
- Family collaboration partner
- Tester providing feedback
- Cofounder helping build the future

---

**Prepared for:** Courtney Blasioli  
**Date:** 2026-05-30  
**Setup Method:** Zip file + PowerShell (current working method)  
**Future Method:** Exe installer (when built)
