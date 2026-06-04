const path = require("path");
const { spawn, spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..", "..");

function commandExists(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], { stdio: "ignore" });
  return result.status === 0;
}

function getPowerShellCommand() {
  const candidates = process.platform === "win32"
    ? ["powershell.exe", "pwsh.exe", "powershell", "pwsh"]
    : ["pwsh", "powershell"];
  return candidates.find(commandExists) || null;
}

function runPowerShell(scriptRelativePath, args = []) {
  return new Promise((resolve) => {
    const powerShellCommand = getPowerShellCommand();
    if (!powerShellCommand) {
      resolve({
        code: 2,
        stdout: "",
        stderr: "PowerShell is not installed in this environment; run this action on the operator machine.",
      });
      return;
    }

    const scriptPath = path.join(repoRoot, scriptRelativePath);
    const child = spawn(powerShellCommand, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...args,
    ], { cwd: repoRoot });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (error) => resolve({ code: 2, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

module.exports = {
  commandExists,
  getPowerShellCommand,
  runPowerShell,
};
