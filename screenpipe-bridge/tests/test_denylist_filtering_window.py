from app.denylist import Denylist


def test_window_title_substring_case_insensitive():
    dl = Denylist(apps=[], url_patterns=[], window_titles=["Password", "Incognito"])
    assert dl.matches({"app": "Chrome", "window": "Settings — Password Manager", "url": None})
    assert dl.matches({"app": "Chrome", "window": "incognito tab", "url": None})
    assert not dl.matches({"app": "Chrome", "window": "Inbox", "url": None})
