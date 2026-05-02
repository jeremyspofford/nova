"""Test boundary fake for the GitHub REST API."""
from .server import FakeGitHubServer, load_scenario

__all__ = ["FakeGitHubServer", "load_scenario"]
