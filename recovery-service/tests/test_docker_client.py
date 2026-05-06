"""Unit tests for SDK base-URL routing in docker_client (SEC-006b).

In production, the recovery container should point its Docker SDK at the
docker-socket-proxy sidecar (TCP) so SDK operations are gated by an explicit
allowlist (CONTAINERS=1, POST=1).  The compose CLI subprocess in
compose_client.py keeps using the raw unix socket because compose ops
require full Docker API access — that separation is the trust boundary.

These tests pin the routing behavior of `_client()`:
  - DOCKER_SDK_HOST set    → construct with that base_url
  - DOCKER_SDK_HOST unset  → fall back to docker.DockerClient.from_env()
"""
from unittest.mock import MagicMock

from app.docker_client import _client


def test_client_uses_docker_sdk_host_when_set(monkeypatch):
    monkeypatch.setenv("DOCKER_SDK_HOST", "tcp://docker-socket-proxy:2375")
    mock_class = MagicMock()
    monkeypatch.setattr("app.docker_client.docker.DockerClient", mock_class)

    _client()

    mock_class.assert_called_once_with(base_url="tcp://docker-socket-proxy:2375")
    mock_class.from_env.assert_not_called()


def test_client_falls_back_to_from_env_when_unset(monkeypatch):
    monkeypatch.delenv("DOCKER_SDK_HOST", raising=False)
    mock_class = MagicMock()
    monkeypatch.setattr("app.docker_client.docker.DockerClient", mock_class)

    _client()

    mock_class.from_env.assert_called_once_with()
    mock_class.assert_not_called()


def test_client_falls_back_when_docker_sdk_host_is_empty(monkeypatch):
    monkeypatch.setenv("DOCKER_SDK_HOST", "")
    mock_class = MagicMock()
    monkeypatch.setattr("app.docker_client.docker.DockerClient", mock_class)

    _client()

    mock_class.from_env.assert_called_once_with()
    mock_class.assert_not_called()
