"""Tests for SSRF URL validation."""
from nova_worker_common.url_validator import validate_url


class TestBlockedServiceHostnames:
    def test_orchestrator(self):
        assert validate_url("http://orchestrator:8000/api") is not None

    def test_redis(self):
        assert validate_url("http://redis:6379") is not None

    def test_knowledge_worker(self):
        assert validate_url("http://knowledge-worker:8120/health") is not None

    def test_intel_worker(self):
        assert validate_url("http://intel-worker:8110") is not None

    def test_llm_gateway(self):
        assert validate_url("http://llm-gateway:8001/complete") is not None

    def test_memory_service(self):
        assert validate_url("http://memory-service:8002/api") is not None

    def test_cortex(self):
        assert validate_url("http://cortex:8100") is not None

    def test_dashboard(self):
        assert validate_url("http://dashboard:3000") is not None

    def test_recovery(self):
        assert validate_url("http://recovery:8888") is not None

    def test_postgres(self):
        assert validate_url("http://postgres:5432") is not None

    def test_chat_api(self):
        assert validate_url("http://chat-api:8080") is not None


class TestBlockedPrivateIPs:
    def test_10_network(self):
        assert validate_url("http://10.0.0.1/secret") is not None

    def test_172_16_network(self):
        assert validate_url("http://172.16.0.1/internal") is not None

    def test_192_168_network(self):
        assert validate_url("http://192.168.1.1/admin") is not None


class TestBlockedLoopback:
    def test_127_0_0_1(self):
        result = validate_url("http://127.0.0.1:8000/api")
        assert result is not None

    def test_localhost(self):
        result = validate_url("http://localhost:8000/api")
        assert result is not None


class TestBlockedMetadata:
    def test_link_local(self):
        result = validate_url("http://169.254.169.254/latest/meta-data/")
        assert result is not None

    def test_google_metadata(self):
        result = validate_url("http://metadata.google.internal/computeMetadata/v1/")
        assert result is not None

    def test_docker_internal(self):
        result = validate_url("http://host.docker.internal:2375")
        assert result is not None


class TestBlockedSchemes:
    def test_ftp(self):
        result = validate_url("ftp://example.com/file.txt")
        assert result is not None
        assert "ftp" in result

    def test_file(self):
        result = validate_url("file:///etc/passwd")
        assert result is not None
        assert "file" in result


class TestValidURLs:
    def test_https_example(self):
        assert validate_url("https://example.com") is None

    def test_https_github(self):
        assert validate_url("https://github.com/arialabs/nova") is None

    def test_http_external(self):
        assert validate_url("http://feeds.feedburner.com/rss") is None

    def test_https_with_path(self):
        assert validate_url("https://blog.anthropic.com/rss.xml") is None


class TestExtraBlockedHosts:
    def test_extra_host_blocked(self):
        result = validate_url(
            "https://evil.example.com/api",
            extra_blocked_hosts={"evil.example.com"},
        )
        assert result is not None
        assert "evil.example.com" in result

    def test_extra_does_not_affect_valid(self):
        result = validate_url(
            "https://example.com",
            extra_blocked_hosts={"evil.example.com"},
        )
        assert result is None

    def test_original_blocks_still_apply(self):
        result = validate_url(
            "http://redis:6379",
            extra_blocked_hosts={"evil.example.com"},
        )
        assert result is not None
