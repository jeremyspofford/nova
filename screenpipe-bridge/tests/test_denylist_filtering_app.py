from app.denylist import Denylist


def test_app_denylist_exact_match():
    dl = Denylist(apps=["1Password"], url_patterns=[], window_titles=[])
    assert dl.matches({"app": "1Password", "window": "Vault", "url": None})
    assert not dl.matches({"app": "VS Code", "window": "1Password notes", "url": None})


def test_app_denylist_case_sensitive():
    dl = Denylist(apps=["1Password"], url_patterns=[], window_titles=[])
    assert not dl.matches({"app": "1password", "window": "x", "url": None})
