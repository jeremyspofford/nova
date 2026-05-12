"""Import all built-in tools to trigger @tool self-registration."""
from . import fs, web, git, memory, subagent  # noqa: F401

# shell + code are added in Task 7 (sandbox infrastructure)
try:
    from . import shell, code  # noqa: F401
except ImportError:
    pass
