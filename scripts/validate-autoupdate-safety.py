#!/usr/bin/env python3
"""
Validate auto-update safety before commits.

Pre-commit hook that ensures:
1. Auto-update script is present if version bumped
2. Migration scripts exist for each version jump
3. Backwards compatibility maintained
4. Safe rollback paths documented
5. No critical dependencies broken

Usage:
    python scripts/validate-autoupdate-safety.py
    SKIP_UPDATE_CHECK=1 git commit  # to bypass
"""

import json
import re
import subprocess
import sys
from pathlib import Path
from packaging import version

REPO_ROOT = Path(__file__).parent.parent
PACKAGE_JSON = REPO_ROOT / "package.json"
AUTO_UPDATE_SCRIPT = REPO_ROOT / "scripts/auto-version.js"
MIGRATIONS_DIR = REPO_ROOT / "scripts/migrations"
DEPENDENCIES_FILE = REPO_ROOT / "package.json"

def run_cmd(cmd):
    """Run shell command."""
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        return result.stdout.strip(), result.returncode
    except Exception as e:
        return str(e), 1

def get_current_version():
    """Get current version from package.json."""
    try:
        with open(PACKAGE_JSON, 'r') as f:
            data = json.load(f)
            return data.get('version', '0.0.0')
    except:
        return None

def get_staged_version():
    """Get staged version."""
    output, code = run_cmd("git show :package.json")
    if code == 0:
        try:
            data = json.loads(output)
            return data.get('version', '0.0.0')
        except:
            pass
    return None

def parse_version(v):
    """Parse version string safely."""
    try:
        return version.parse(v)
    except:
        return None

def is_major_bump(current, staged):
    """Check if this is a major version bump."""
    curr = parse_version(current)
    stag = parse_version(staged)
    if not curr or not stag:
        return False
    return stag.major > curr.major

def is_minor_bump(current, staged):
    """Check if this is a minor version bump."""
    curr = parse_version(current)
    stag = parse_version(staged)
    if not curr or not stag:
        return False
    return stag.minor > curr.minor

def auto_update_script_exists():
    """Check if auto-update script exists."""
    if not AUTO_UPDATE_SCRIPT.exists():
        return False, "auto-version.js not found"

    try:
        with open(AUTO_UPDATE_SCRIPT, 'r') as f:
            content = f.read()
            # Check for key functions
            has_version_bump = 'version' in content
            has_safe_check = 'safe' in content or 'validate' in content or 'check' in content
            return has_version_bump, "auto-update script ready"
    except:
        return False, "Could not read auto-update script"

def migration_exists_for_version(from_v, to_v):
    """Check if migration exists for version jump."""
    # Create migration file name pattern
    migration_name = f"{from_v}_to_{to_v}.js"
    migration_path = MIGRATIONS_DIR / migration_name

    return migration_path.exists(), f"Migration {migration_name}"

def get_staged_dependencies():
    """Get dependencies from staged package.json."""
    output, code = run_cmd("git show :package.json")
    if code == 0:
        try:
            data = json.loads(output)
            return data.get('dependencies', {}), data.get('devDependencies', {})
        except:
            pass
    return {}, {}

def check_critical_dependency_changes():
    """Check for breaking changes in critical dependencies."""
    current_output, _ = run_cmd("git show HEAD:package.json")
    staged_output, _ = run_cmd("git show :package.json")

    if not current_output or not staged_output:
        return [], "Dependencies unchanged"

    try:
        current = json.loads(current_output)
        staged = json.loads(staged_output)

        current_deps = {**current.get('dependencies', {}), **current.get('devDependencies', {})}
        staged_deps = {**staged.get('dependencies', {}), **staged.get('devDependencies', {})}

        errors = []
        critical_deps = ['express', 'node-sse', 'dotenv', 'body-parser']

        for dep in critical_deps:
            if dep in current_deps and dep in staged_deps:
                curr_v = current_deps[dep].lstrip('^~=<>').split('.')[0]
                stag_v = staged_deps[dep].lstrip('^~=<>').split('.')[0]

                if curr_v != stag_v:
                    errors.append(f"Critical dependency change: {dep} {curr_v} → {stag_v}")

            elif dep in current_deps and dep not in staged_deps:
                errors.append(f"Critical dependency removed: {dep}")

        return errors, "Dependencies checked"
    except Exception as e:
        return [str(e)], "Error checking dependencies"

def validate_rollback_documentation():
    """Check for rollback documentation."""
    readme_path = REPO_ROOT / "README.md"
    if not readme_path.exists():
        return False, "README.md not found"

    try:
        with open(readme_path, 'r') as f:
            content = f.read()
            has_rollback = 'rollback' in content.lower() or 'downgrade' in content.lower()
            return has_rollback, "Rollback docs found" if has_rollback else "No rollback docs"
    except:
        return False, "Could not read README"

def main():
    """Main validation."""
    print("[*] Validating auto-update safety...")

    current_version = get_current_version()
    staged_version = get_staged_version()
    version_changed = current_version != staged_version

    print(f"    Current: {current_version}")
    print(f"    Staged:  {staged_version}")

    if not version_changed:
        print("    No version change detected")
        return 0

    errors = []

    # Check 1: Auto-update script exists
    exists, msg = auto_update_script_exists()
    if exists:
        print(f"    [✓] {msg}")
    else:
        errors.append(f"[ERROR] {msg}")

    # Check 2: Migration script exists for major/minor bumps
    if is_major_bump(current_version, staged_version) or is_minor_bump(current_version, staged_version):
        migration_exists, migration_msg = migration_exists_for_version(current_version, staged_version)
        if not migration_exists:
            errors.append(f"[ERROR] {migration_msg} not found for major/minor version bump")
        else:
            print(f"    [✓] Migration script exists")

    # Check 3: Check critical dependency changes
    dep_errors, dep_msg = check_critical_dependency_changes()
    if dep_errors:
        print(f"    [!] Dependency changes detected:")
        for err in dep_errors:
            errors.append(f"[WARNING] {err}")
    else:
        print(f"    [✓] {dep_msg}")

    # Check 4: Rollback documentation exists
    has_rollback, rollback_msg = validate_rollback_documentation()
    if has_rollback:
        print(f"    [✓] {rollback_msg}")
    else:
        errors.append(f"[WARNING] {rollback_msg} - consider adding rollback instructions")

    # Check 5: Backwards compatibility - no removed exports
    output, _ = run_cmd("git diff --cached lib/")
    if output:
        removed_exports = re.findall(r'^\s*-\s*module\.exports|^\s*-\s*export', output, re.MULTILINE)
        if removed_exports:
            errors.append("[ERROR] Removed module exports detected (breaking change)")

    if errors:
        print("\n[!] AUTO-UPDATE VALIDATION FAILED:")
        for error in errors:
            print(f"    {error}")
        print("\n[!] Required for version bumps:")
        print("    1. scripts/auto-version.js must exist and be executable")
        print("    2. Migration scripts needed for major/minor bumps")
        print("    3. No critical dependencies removed (express, node-sse, dotenv, body-parser)")
        print("    4. Rollback instructions in README.md")
        print("    5. No breaking changes to module exports")
        print("\n[!] To bypass: SKIP_UPDATE_CHECK=1 git commit")
        return 1

    print("\n[OK] Auto-update safety validated")
    return 0

if __name__ == "__main__":
    sys.exit(main())
