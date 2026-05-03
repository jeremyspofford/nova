from app.denylist import Denylist


def test_url_denylist_regex_match():
    dl = Denylist(apps=[], url_patterns=[r"^https://.*\.bank/"], window_titles=[])
    assert dl.matches({"app": "Chrome", "window": "Login", "url": "https://chase.bank/login"})
    assert not dl.matches({"app": "Chrome", "window": "Login", "url": "https://example.com/"})


def test_url_denylist_no_match_when_url_missing():
    dl = Denylist(apps=[], url_patterns=[r"^https://.*\.bank/"], window_titles=[])
    assert not dl.matches({"app": "VS Code", "window": "x", "url": None})
