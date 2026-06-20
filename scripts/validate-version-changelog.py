#!/usr/bin/env python3
"""
Enforce version bump and changelog entry consistency.

Pre-commit hook that validates:
1. If code files changed, version must be bumped
2. If version bumped, changelog must be updated
3. Version format is semantic (major.minor.patch)
4. Changelog entry exists for the new version
5. Changelog entry has required fields (date, summary, impact)

Run via pre-commit hook or manually:
    python scripts/validate-version-changelog.py
"""

import json
import re
import subprocess
import sys
from pathlib import Path
from datetime import datetime

REPO_ROOT = Path(__file__).parent.parent
VERSION_FILE = REPO_ROOT / "package.json"


def _resolve_changelog():
    """Find the changelog regardless of filename casing (CHANGELOG.MD on disk,
    but case-sensitive filesystems need the exact name)."""
    for name in ("CHANGELOG.MD", "CHANGELOG.md", "CHANGELOG.markdown"):
        candidate = REPO_ROOT / name
        if candidate.exists():
            return candidate
    return REPO_ROOT / "CHANGELOG.MD"


CHANGELOG_FILE = _resolve_changelog()

# Files that trigger version bump requirement (ignore test/doc changes)
CODE_FILES_PATTERN = re.compile(r"""
    ^(?!
        test/|
        docs/|
        \.md$|
        \.github/|
        \.claude/
    )
    .*\.(js|ts|py|jsx|tsx|json)$
""", re.VERBOSE)

def run_cmd(cmd):
    """Run shell command and return output."""
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True,
            encoding="utf-8", errors="replace",
        )
        return (result.stdout or "").strip(), result.returncode
    except Exception as e:
        return str(e), 1

def get_staged_files():
    """Get list of staged files from git."""
    output, _ = run_cmd("git diff --cached --name-only")
    return output.split('\n') if output else []

def get_current_version():
    """Read current version from package.json."""
    try:
        with open(VERSION_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data.get('version', '0.0.0')
    except Exception as e:
        print(f"[!] Error reading version: {e}")
        return None

def get_staged_version():
    """Get version from staged package.json."""
    try:
        output, code = run_cmd("git show :package.json")
        if code == 0:
            data = json.loads(output)
            return data.get('version', '0.0.0')
    except Exception:
        pass
    return None

def is_valid_semver(version):
    """Check if version is valid semantic versioning."""
    pattern = r'^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$'
    return bool(re.match(pattern, version))

def has_code_changes(files):
    """Check if staged files include code changes (not just tests/docs)."""
    return any(CODE_FILES_PATTERN.match(f) for f in files if f)

def get_changelog_entries():
    """Parse changelog and return versions with entries."""
    try:
        with open(CHANGELOG_FILE, 'r', encoding='utf-8') as f:
            content = f.read()
            # Match version headers: ## [1.2.3] - 2026-06-08
            versions = re.findall(r'## \[([^\]]+)\]', content)
            return set(versions)
    except FileNotFoundError:
        return set()

def validate_changelog_entry(version):
    """Validate that changelog has proper entry for version."""
    try:
        with open(CHANGELOG_FILE, 'r', encoding='utf-8') as f:
            content = f.read()

        # Look for version header
        pattern = rf'## \[{re.escape(version)}\] - (\d{{4}}-\d{{2}}-\d{{2}})'
        match = re.search(pattern, content)

        if not match:
            return False, "Version not found in changelog"

        # Extract the section for this version
        version_idx = match.start()
        next_version_idx = content.find('\n## [', version_idx + 1)
        if next_version_idx == -1:
            version_section = content[version_idx:]
        else:
            version_section = content[version_idx:next_version_idx]

        # Check for required subsections
        required = ['### Added', '### Fixed', '### Changed']
        found = [s for s in required if s in version_section]

        if not found:
            return False, f"Changelog entry missing sections. Need at least one of: {required}"

        # Check for actual content (not empty)
        for section in found:
            section_start = version_section.find(section)
            next_section_start = version_section.find('\n###', section_start + 1)
            if next_section_start == -1:
                section_content = version_section[section_start:]
            else:
                section_content = version_section[section_start:next_section_start]

            # Count list items (- Item)
            items = re.findall(r'\n\s*-\s+', section_content)
            if not items:
                return False, f"Changelog section '{section}' is empty"

        return True, "Valid changelog entry"
    except Exception as e:
        return False, str(e)

def main():
    """Main validation logic."""
    print("[*] Validating version and changelog...")

    # Get staged files
    staged_files = get_staged_files()
    has_code = has_code_changes(staged_files)

    # Check if version was changed
    current_version = get_current_version()
    staged_version = get_staged_version()
    version_changed = current_version != staged_version

    print(f"    Current version: {current_version}")
    print(f"    Staged version:  {staged_version}")
    print(f"    Code changed: {has_code}")
    print(f"    Version changed: {version_changed}")

    errors = []

    # Rule 1: If version was changed, validate format
    if version_changed and staged_version:
        if not is_valid_semver(staged_version):
            errors.append(f"[ERROR] Invalid version format: '{staged_version}'. Must be semantic (major.minor.patch)")
        else:
            print(f"    [✓] Version format valid: {staged_version}")

    # Rule 2: If code changed but version not changed, warn/error
    if has_code and not version_changed:
        errors.append(f"[ERROR] Code files changed but version not bumped (still {current_version})")

    # Rule 3: If version changed, changelog must be updated
    if version_changed and staged_version:
        changelog_entries = get_changelog_entries()

        if staged_version not in changelog_entries:
            errors.append(f"[ERROR] Version {staged_version} not found in {CHANGELOG_FILE}")
        else:
            print(f"    [✓] Changelog version found: {staged_version}")

            # Rule 4: Validate changelog entry structure
            valid, msg = validate_changelog_entry(staged_version)
            if not valid:
                errors.append(f"[ERROR] Changelog entry invalid: {msg}")
            else:
                print(f"    [✓] Changelog entry valid")

    # Print results
    if errors:
        print("\n[!] VALIDATION FAILED:")
        for error in errors:
            print(f"    {error}")
        print("\n[!] Changelog format (example):")
        print("""
## [1.2.3] - 2026-06-08

### Added
- New feature description

### Fixed
- Bug fix description

### Changed
- API change description
        """)
        return 1

    print("\n[OK] All validations passed")
    return 0

if __name__ == "__main__":
    sys.exit(main())
