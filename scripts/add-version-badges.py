#!/usr/bin/env python3
"""Add dynamic version badges to all HTML pages in Lantern OS public dir."""
import re, os

PUBLIC_DIR = 'public'

SHARED_SCRIPT = """\n<!-- Version badge auto-loader -->\n<script>\n(function() {\n  const base = window.location.origin;\n  fetch(base + '/version.json', { cache: 'no-store' })\n    .then(r => r.ok ? r.json() : null)\n    .then(v => {\n      if (!v || !v.version) return;\n      document.querySelectorAll('[data-version-badge]').forEach(el => {\n        const prefix = el.dataset.versionBadge || '';\n        el.textContent = prefix + 'v' + v.version;\n        el.style.cursor = 'pointer';\n        el.title = 'View changelog';\n        el.onclick = function() { window.open('/repo/CHANGELOG.MD', '_blank'); };\n      });\n    })\n    .catch(() => {});\n})();\n</script>\n"""

def process_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    # Skip if already processed
    if 'data-version-badge' in content:
        print(f"SKIP (already has badge): {path}")
        return False

    # Skip if no version references
    if not re.search(r'v\d+\.\d+\.\d+|Orion Edition', content):
        print(f"SKIP (no version refs): {path}")
        return False

    original = content

    # Pattern 1: Orion Edition · vX.Y.Z · Lantern OS ...
    content = re.sub(
        r'(Orion Edition\s*·\s*)v\d+\.\d+\.\d+(\s*·\s*Lantern OS)',
        r'\1<span data-version-badge="Orion Edition · ">v1.0.2</span>\2',
        content
    )

    # Pattern 2: Lantern OS · private · local · vX.Y.Z
    content = re.sub(
        r'(Lantern OS\s*·\s*private\s*·\s*local\s*·\s*)v\d+\.\d+\.\d+',
        r'\1<span data-version-badge="Lantern OS · private · local · ">v1.0.0</span>',
        content
    )

    # Pattern 3: standalone vX.Y.Z in spans/paragraphs (not in titles)
    content = re.sub(
        r'>([^<]*)v(\d+\.\d+\.\d+)([^<]*)<',
        r'><span data-version-badge="\1">v\2</span>\3<',
        content
    )

    # Inject script before </body>
    if '</body>' in content and 'Version badge auto-loader' not in content:
        content = content.replace('</body>', SHARED_SCRIPT + '</body>\n')

    if content == original:
        print(f"SKIP (no changes made): {path}")
        return False

    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)

    print(f"UPDATED: {path}")
    return True


def main():
    updated = 0
    skipped = 0

    # Top-level HTML files
    for fname in os.listdir(PUBLIC_DIR):
        if not fname.endswith('.html'):
            continue
        path = os.path.join(PUBLIC_DIR, fname)
        if process_file(path):
            updated += 1
        else:
            skipped += 1

    # dream-journal subdir
    journal_dir = os.path.join(PUBLIC_DIR, 'dream-journal')
    if os.path.isdir(journal_dir):
        for fname in os.listdir(journal_dir):
            if not fname.endswith('.html'):
                continue
            path = os.path.join(journal_dir, fname)
            if process_file(path):
                updated += 1
            else:
                skipped += 1

    print(f"\nDone: {updated} updated, {skipped} skipped")


if __name__ == '__main__':
    main()
