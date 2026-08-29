"""A validator for exactly the JSON Schema subset the toolset advertises.

Hand-rolled rather than a dependency because the whole vocabulary in use
here is: an object, typed scalar properties, `required`, integer bounds,
and no extra keys. A general-purpose validator would be a lot of surface
area to carry for that, and the error strings would be written for a
developer reading a stack trace rather than for a model reading a tool
result and deciding what to send next.

Everything here returns a stated reason (or None); nothing raises, because
the caller's whole job is to turn "what was wrong" into text the model can
act on.
"""
from __future__ import annotations

from typing import Any

# JSON's types, in JSON's words — the model is being told what its own
# call looked like, so it must be told in the vocabulary it emitted.
_JSON_TYPE_NAMES = {
    bool: "boolean",  # checked before int: python says bool IS an int, JSON does not
    int: "integer",
    float: "number",
    str: "string",
    list: "array",
    dict: "object",
    type(None): "null",
}


def json_type_name(value: Any) -> str:
    return _JSON_TYPE_NAMES.get(type(value), type(value).__name__)


def _matches(value: Any, expected: str) -> bool:
    if expected == "string":
        return type(value) is str
    if expected == "integer":
        # `type(...) is int` on purpose: isinstance(True, int) is True in
        # python, so an isinstance check would quietly accept `true` as a
        # count. JSON has no such confusion and neither does this.
        return type(value) is int
    if expected == "number":
        return type(value) in (int, float)
    if expected == "boolean":
        return type(value) is bool
    if expected == "array":
        return type(value) is list
    if expected == "object":
        return type(value) is dict
    # An unknown type keyword is a bug in a tool's own schema, not in the
    # model's call — accept the value rather than blaming the caller.
    return True


def validate(schema: dict, arguments: Any) -> str | None:
    """None when `arguments` satisfies `schema`, else the stated reason.

    Extra properties are refused whether or not the schema says
    additionalProperties: false. A tool that quietly ignores an argument
    the model believed in is worse than one that says the argument does
    not exist — the model would keep sending it and keep believing it did
    something.
    """
    if type(arguments) is not dict:
        return f"the arguments must be a JSON object, got {json_type_name(arguments)}"

    properties: dict = schema.get("properties") or {}
    known = ", ".join(sorted(properties)) or "none"

    for name in schema.get("required") or []:
        if name not in arguments:
            return f"missing required argument {name!r} — this tool takes: {known}"

    for name, value in arguments.items():
        spec = properties.get(name)
        if spec is None:
            return f"unknown argument {name!r} — this tool takes: {known}"
        expected = spec.get("type")
        if expected is not None and not _matches(value, expected):
            return (
                f"argument {name!r} must be {_article(expected)} {expected}, "
                f"got {json_type_name(value)}"
            )
        bound = _range_failure(name, value, spec)
        if bound is not None:
            return bound
    return None


def _article(word: str) -> str:
    return "an" if word[:1] in "aeiou" else "a"


def _range_failure(name: str, value: Any, spec: dict) -> str | None:
    if type(value) not in (int, float) or type(value) is bool:
        return None
    minimum = spec.get("minimum")
    if minimum is not None and value < minimum:
        return f"argument {name!r} must be at least {minimum}, got {value}"
    maximum = spec.get("maximum")
    if maximum is not None and value > maximum:
        return f"argument {name!r} must be at most {maximum}, got {value}"
    return None
