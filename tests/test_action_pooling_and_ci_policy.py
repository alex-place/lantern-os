from pathlib import Path


def test_action_pooling_policy_uses_typed_intent_not_secret_codes():
    text = Path('docs/ACTION-POOLING-AND-BATCHING.md').read_text(encoding='utf-8')

    required = [
        'Remote search should happen from typed natural-language intent',
        'not from secret trigger strings',
        'Do not require magic words',
        'Human-in-the-loop CAPTCHA completion is allowed only for normal manual use',
        'Do not automate CAPTCHA solving',
        'No fake identities, fake need, spam, or account evasion',
    ]

    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []


def test_ci_workflow_parallel_lanes_and_summary_gate_are_present():
    text = Path('.github/workflows/static-surface-ci.yml').read_text(encoding='utf-8')

    required_jobs = [
        'repo-surface:',
        'manifests:',
        'html-links:',
        'python-tests:',
        'convergence-cloud:',
        'workflow-shape:',
        'summary:',
    ]
    missing_jobs = [job for job in required_jobs if job not in text]
    assert missing_jobs == []

    assert 'needs: [repo-surface, manifests, html-links, python-tests, convergence-cloud, workflow-shape]' in text
    assert 'workflow_dispatch:' in text
    assert 'cancel-in-progress: true' in text
    assert '-CloudVirtualization' in text


def test_convergence_loop_has_cloud_virtualization_boundary():
    text = Path('scripts/Invoke-LanternConvergenceLoop.ps1').read_text(encoding='utf-8')

    required = [
        '[switch]$CloudVirtualization',
        'cloud_metadata_only',
        'Local source tree is not visible from GitHub Actions; inspect locally before mutation.',
        'Cloud repo invariants passed. Run local controls on the operator machine before MCP/local runtime mutation.',
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []
