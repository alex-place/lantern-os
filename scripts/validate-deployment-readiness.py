#!/usr/bin/env python3
"""
Validate deployment readiness before commits.

Pre-commit hook that ensures:
1. If route/server files changed → deployment config updated
2. If deployment config changed → rollback plan documented
3. Health check endpoints exist
4. Deployment safety gates are in place
5. No breaking changes to critical APIs

Usage:
    python scripts/validate-deployment-readiness.py
    SKIP_DEPLOY_CHECK=1 git commit  # to bypass
"""

import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
DEPLOYMENT_CONFIG = REPO_ROOT / "deployment.json"
HEALTH_CHECK = REPO_ROOT / "routes/status.js"
QUICKSTART = REPO_ROOT / "QUICKSTART.md"

# Files that affect deployment
DEPLOYMENT_FILES = re.compile(r"""
    ^(
        server\.js|
        cloud-server\.js|
        routes/|
        lib/
    )
""", re.VERBOSE)

def run_cmd(cmd):
    """Run shell command."""
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        return result.stdout.strip(), result.returncode
    except Exception as e:
        return str(e), 1

def get_staged_files():
    """Get staged files."""
    output, _ = run_cmd("git diff --cached --name-only")
    return [f for f in output.split('\n') if f]

def has_deployment_changes(files):
    """Check if any deployment-critical files changed."""
    return any(DEPLOYMENT_FILES.match(f) for f in files)

def deployment_config_exists():
    """Check deployment config exists."""
    return DEPLOYMENT_CONFIG.exists()

def get_deployment_config():
    """Read deployment config."""
    try:
        with open(DEPLOYMENT_CONFIG, 'r') as f:
            return json.load(f)
    except Exception as e:
        return None

def validate_deployment_config(config):
    """Validate deployment config structure."""
    errors = []

    required_fields = ['version', 'status', 'lastDeployed', 'environment', 'rollbackPlan']
    for field in required_fields:
        if field not in config:
            errors.append(f"Missing required field: {field}")

    # Validate structure
    if 'rollbackPlan' in config:
        rollback = config['rollbackPlan']
        if not isinstance(rollback, dict):
            errors.append("rollbackPlan must be a dict with steps")
        elif 'steps' not in rollback:
            errors.append("rollbackPlan missing 'steps' array")
        elif not isinstance(rollback['steps'], list) or len(rollback['steps']) == 0:
            errors.append("rollbackPlan.steps must be non-empty array")

    if 'environment' in config:
        env = config['environment']
        if 'name' not in env or 'region' not in env:
            errors.append("environment must have 'name' and 'region'")

    if 'healthChecks' in config:
        if not isinstance(config['healthChecks'], list):
            errors.append("healthChecks must be an array")

    return errors

def health_check_endpoints_exist():
    """Verify health check endpoints are defined."""
    if not HEALTH_CHECK.exists():
        return False, "Health check file not found"

    try:
        with open(HEALTH_CHECK, 'r') as f:
            content = f.read()
            # Check for common health check patterns
            has_health = '/health' in content or '/status' in content or 'healthz' in content
            return has_health, "Health endpoints defined" if has_health else "No health endpoints found"
    except Exception as e:
        return False, str(e)

def validate_api_backwards_compatibility():
    """Check for breaking API changes."""
    # Get staged changes to routes
    output, _ = run_cmd("git diff --cached routes/")

    if not output:
        return [], "No route changes"

    errors = []
    lines = output.split('\n')

    # Look for patterns that indicate breaking changes
    breaking_patterns = [
        (r'-\s*router\.get\(', "Removed GET endpoint (breaking)"),
        (r'-\s*router\.post\(', "Removed POST endpoint (breaking)"),
        (r'-\s*router\.delete\(', "Removed DELETE endpoint (breaking)"),
        (r'^\s*-\s*/api/\w+', "Removed API route (breaking)"),
        (r'\.required\(\)', "Made field required (breaking)"),
    ]

    for line in lines:
        for pattern, msg in breaking_patterns:
            if re.search(pattern, line):
                errors.append(f"Potential breaking change: {msg} - {line.strip()}")

    return errors, "API compatible" if not errors else f"Found {len(errors)} potential breaking changes"

def validate_staged_deployment_config():
    """Check staged deployment.json if it exists."""
    output, code = run_cmd("git show :deployment.json")

    if code != 0:
        return [], "No staged deployment.json"

    try:
        config = json.loads(output)
        errors = validate_deployment_config(config)
        return errors, "Deployment config valid" if not errors else f"Config has {len(errors)} issues"
    except json.JSONDecodeError as e:
        return [f"Invalid JSON in staged deployment.json: {e}"], "JSON parse error"
    except Exception as e:
        return [str(e)], "Error parsing config"

def main():
    """Main validation."""
    print("[*] Validating deployment readiness...")

    files = get_staged_files()
    has_deploy_changes = has_deployment_changes(files)

    if not has_deploy_changes:
        print("    No deployment-critical files changed")
        return 0

    print(f"    [!] Deployment-critical files changed ({sum(1 for f in files if DEPLOYMENT_FILES.match(f))} files)")

    errors = []

    # Check 1: Deployment config exists
    if not deployment_config_exists():
        errors.append("[ERROR] deployment.json not found")
        errors.append("        Create deployment.json with rollback plan, health checks, and environment info")
    else:
        print("    [✓] Deployment config exists")

        # Check 2: Validate config structure
        config = get_deployment_config()
        if config:
            config_errors = validate_deployment_config(config)
            if config_errors:
                for err in config_errors:
                    errors.append(f"[ERROR] Config error: {err}")
            else:
                print("    [✓] Deployment config valid")

            # Check 3: Verify staged config if changed
            staged_errors, msg = validate_staged_deployment_config()
            if staged_errors:
                print(f"    [!] Staged config issues:")
                for err in staged_errors:
                    errors.append(f"[ERROR] Staged config: {err}")
            else:
                print(f"    [✓] Staged config valid")

    # Check 4: Health check endpoints exist
    has_health, health_msg = health_check_endpoints_exist()
    if has_health:
        print(f"    [✓] {health_msg}")
    else:
        errors.append(f"[ERROR] {health_msg}")

    # Check 5: API backwards compatibility
    api_errors, api_msg = validate_api_backwards_compatibility()
    if api_errors:
        print(f"    [!] {api_msg}:")
        for err in api_errors:
            errors.append(f"[WARNING] {err}")
    else:
        print(f"    [✓] {api_msg}")

    if errors:
        print("\n[!] DEPLOYMENT VALIDATION FAILED:")
        for error in errors:
            print(f"    {error}")
        print("\n[!] Required deployment.json format:")
        print("""
{
  "version": "1.2.4",
  "status": "ready",
  "environment": {
    "name": "production",
    "region": "us-east-1"
  },
  "lastDeployed": "2026-06-08T22:00:00Z",
  "healthChecks": [
    "/health",
    "/api/status"
  ],
  "rollbackPlan": {
    "previousVersion": "1.2.3",
    "steps": [
      "Stop current deployment",
      "Revert to previous version",
      "Verify health checks pass",
      "Notify operators"
    ]
  }
}
        """)
        print("[!] To bypass: SKIP_DEPLOY_CHECK=1 git commit")
        return 1

    print("\n[OK] Deployment readiness validated")
    return 0

if __name__ == "__main__":
    sys.exit(main())
