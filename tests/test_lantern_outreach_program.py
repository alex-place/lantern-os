from pathlib import Path


def test_outreach_program_page_exists_and_keeps_boundaries():
    text = Path('apps/lantern-garage/public/outreach.html').read_text(encoding='utf-8')
    required = [
        'Lantern OS Outreach Program',
        '937-641-3405',
        '937-222-0410',
        '513-421-3131',
        'No cure claims',
        'No miracle claims',
        'GitHub Sponsors is personal/project support',
    ]
    assert [phrase for phrase in required if phrase not in text] == []


def test_dashboard_links_to_outreach_program():
    text = Path('apps/lantern-garage/public/index.html').read_text(encoding='utf-8')
    assert 'href="/outreach.html"' in text
    assert 'Outreach Program' in text


def test_render_server_uses_public_bind_and_holds_local_actions():
    text = Path('apps/lantern-garage/render-server.js').read_text(encoding='utf-8')
    required = [
        'process.env.PORT',
        '0.0.0.0',
        '/health',
        '/outreach',
        'Action held in Render mode.',
        'local orchestrator queue is not exposed on Render',
    ]
    assert [phrase for phrase in required if phrase not in text] == []


def test_render_blueprint_uses_render_entrypoint():
    text = Path('render.yaml').read_text(encoding='utf-8')
    assert 'rootDir: apps/lantern-garage' in text
    assert 'startCommand: node render-server.js' in text
