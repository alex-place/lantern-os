from pathlib import Path


def test_outreach_surface_stays_removed():
    # outreach.html was cut as sprawl in the surface-boundary "teeth" pass
    # (9 sprawl surfaces removed). Guard that it does not creep back in, and
    # that no nav still links to it. The surface-boundary suite is the primary
    # anti-sprawl gate; this is a targeted regression guard for this surface.
    assert not Path('apps/lantern-garage/public/outreach.html').exists()
    index = Path('apps/lantern-garage/public/index.html').read_text(encoding='utf-8')
    assert 'href="/outreach.html"' not in index


def test_render_blueprint_is_retired_for_aws_pivot():
    assert not Path('render.yaml').exists()
    text = Path('docs/LANTERN-RUNTIME-CICD.md').read_text(encoding='utf-8')
    assert 'Do not re-add `render.yaml`' in text
