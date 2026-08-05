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

# ...and a reference ANYWHERE ELSE in the document. Used to refuse them in
# the URL, where the same resolution that makes headers safe makes a URL a
# way out of the building.
_SECRET_ANYWHERE = re.compile(r"\{\{secret:[A-Za-z0-9_.-]+\}\}")


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

    @field_validator("url")
    @classmethod
    def _no_secret_in_url(cls, v: str) -> str:
        """A credential may ride in a HEADER. Never in the URL.

        `mcp_client` resolves `{{secret:name}}` at the outbound call, and it
        does so on the URL as well as the headers. That is right for a header
        — the value lives from there to the end of the request — and it is a
        way out of the building for a URL, because a URL is not private:

          * `recommendations.create()` spawns `preflight()` the instant a card
            row is written, so the request goes out BEFORE any operator sees
            the card. Zero clicks, no approval, no `actions.enabled` gate.
          * whatever the model put after the host is a request line to a host
            the model chose, with the resolved secret in it;
          * and it does not even need the target to answer. `mcp_client`
            logs the resolved URL and `explain()` embeds it in the error, so
            the plaintext lands in `recommendations.action_detail` — in
            Postgres, and rendered on the operator's own card.

        `preflight` already drops headers for a model-authored plan on
        exactly this reasoning ("A model choosing both a URL and the
        credentials sent to it is an exfiltration primitive"). The URL
        carried the same primitive and nothing dropped it. So it is
        unrepresentable now, which is what this file is for.
        """
        if _SECRET_ANYWHERE.search(v):
            raise ValueError(
                "a URL may not contain a {{secret:...}} reference — it would "
                "be resolved and dialled before anyone reads this card, and "
                "the resolved value would be written to the card and the log. "
                "Put the credential in a header instead")
        return v

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


class HomeAssistantDeploy(_Action):
    """Bring up the Home Assistant service defined in docker-compose.yml.

    NOTE WHAT IS NOT HERE, because the absences are the design. No image, no
    ports, no volumes, no environment, no compose YAML of any kind. The
    service block is in `docker-compose.yml`, in git, reviewed — and this
    document cannot reach it. The only thing the model gets to decide is
    whether to ask, and why.

    That was Jeremy's call on 2026-08-05, choosing typed executors over a
    general compose-deploy verb. The sidecar that actually runs it holds the
    docker socket, so its API is a fixed verb list; this schema is the same
    boundary one layer up. A second service means a new block in that file, a
    new verb on the sidecar, and a new model here — three reviewed edits, on
    purpose, rather than one free-text field.

    `timezone` is the single exception and it is not passed through: the
    executor validates it against the host's zoneinfo and it reaches compose
    as an environment variable that the image itself parses. An unknown zone
    fails the preflight rather than the container.
    """

    type: Literal["home_assistant.deploy"]
    # IANA zone names only — the shape rules out path traversal and shell
    # metacharacters before the value is looked up at all.
    timezone: Annotated[str, StringConstraints(
        pattern=r"^[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+){0,2}$",
        max_length=64)] = "America/New_York"
    why: Annotated[str, StringConstraints(max_length=280)]


ActionDoc = Annotated[Union[McpServerAdd, HomeAssistantDeploy],
                      Field(discriminator="type")]
