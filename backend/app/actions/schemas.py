"""Typed action documents — a form a model fills in, not a script it writes.

An `action` on a recommendation card is a COMPLETE DESCRIPTION OF A FINAL
STATE that the backend already has an operator-only route for. It is never a
command, never a shell string, and there is no free-text field anywhere on
the path between the model and an executor.

The property this buys is not "we validate carefully". It is that the
dangerous cases are UNREPRESENTABLE:

  * there is no `command` field, so `npx -y some-package` cannot be written
    down at all — see `transport` below;
  * there is no id/name field naming an EXISTING row, so nothing already in
    the database can be mutated or deleted by an approved card;
  * `extra="forbid"` means a field nobody has thought about cannot ride
    along inside a document that otherwise typechecks.

Adding a capability here is a visible schema change in a reviewed file, not
a prompt tweak. That is the whole point of the file existing.
"""

import re
from typing import Annotated, Literal, Union

from pydantic import (BaseModel, ConfigDict, Field, StringConstraints,
                      field_validator)


class _Action(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# A header VALUE may only ever be a reference into the secrets store. The
# store resolves it at the outbound call (mcp_client.py), so the credential
# lives from there to the end of the request and never sits in a jsonb
# column, a trace, or a card the operator screenshots.
_SECRET_REF = re.compile(r"^\{\{secret:[A-Za-z0-9_.-]+\}\}$")


class McpServerAdd(_Action):
    """Register a remote MCP server and connect to it.

    `transport` is `Literal["http"]` and that is a security control, not a
    limitation waiting to be lifted. A stdio server is EXECUTED in order to
    list its tools (mcp_servers._check_stdio_command), so registering one is
    running third-party code. "The operator clicked Approve on a card
    summarising a web page" is not enough authority for that. Stdio servers
    are registered by hand in Library -> Tools, where the person typing the
    command is the person who chose it.
    """

    type: Literal["mcp_server.add"]
    name: Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9-]{1,38}$")]
    transport: Literal["http"]
    url: Annotated[str, StringConstraints(pattern=r"^https://")]
    headers: dict[str, str] = Field(default_factory=dict)
    read_only: bool = False
    grant_to: list[str] = Field(default_factory=list)
    why: Annotated[str, StringConstraints(max_length=280)]

    @field_validator("headers")
    @classmethod
    def _no_literal_credentials(cls, v: dict[str, str]) -> dict[str, str]:
        for k, val in v.items():
            if not _SECRET_REF.match(val):
                raise ValueError(
                    f"header {k!r} must be a secret reference like "
                    "{{secret:name}} — put the value in Settings -> Secrets "
                    "and reference it, never inline the credential")
        return v


ActionDoc = Annotated[Union[McpServerAdd], Field(discriminator="type")]
