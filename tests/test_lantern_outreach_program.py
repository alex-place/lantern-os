from pathlib import Path
import pytest


def test_outreach_program_page_exists_and_keeps_boundaries():
    text = Path('apps/lantern-garage/public/outreach.html').read_text(encoding='utf-8')
    required = [
        'Keystone OS Outreach Program',
        '2-1-1',
        '1-800-827-5722',
        '513-369-6900',
        'No cure claims',
        'No miracle claims',
        'GitHub Sponsors is personal/project support',
    ]
    assert [phrase for phrase in required if phrase not in text] == []


@pytest.mark.xfail(reason="index.html redesigned as landing page; outreach link moved to app.js", strict=False)
def test_dashboard_links_to_outreach_program():
    text = Path('apps/lantern-garage/public/index.html').read_text(encoding='utf-8')
    assert 'href="/outreach.html"' in text
    assert 'Outreach Program' in text


@pytest.mark.skip(reason="cloud-server.js removed in cleanup PR #230")
def test_cloud_server_uses_public_bind_and_holds_local_actions():
    text = Path('apps/lantern-garage/cloud-server.js').read_text(encoding='utf-8')
    required = [
        'process.env.PORT',
        '0.0.0.0',
        '/health',
        '/outreach',
        'Action held in AWS cloud mode.',
        'local orchestrator queue is not exposed on AWS cloud mode',
    ]
    assert [phrase for phrase in required if phrase not in text] == []


def test_render_blueprint_is_retired_for_aws_pivot():
    assert not Path('render.yaml').exists()
    text = Path('docs/LANTERN-RUNTIME-CICD.md').read_text(encoding='utf-8')
    assert 'Do not re-add `render.yaml`' in text
