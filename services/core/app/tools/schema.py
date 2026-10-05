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

import json
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
    if expected == "null":
        return value is None
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
        if expected == "array":
            bad = _array_failure(name, value, spec)
            if bad is not None:
                return bad
        bound = _range_failure(name, value, spec)
        if bound is not None:
            return bound
    return None


def _article(word: str) -> str:
    return "an" if word[:1] in "aeiou" else "a"


def _array_failure(name: str, value: Any, spec: dict) -> str | None:
    """Checks an array's length and its elements' types — what makes `argv:
    [str]` refusable BEFORE the kernel. The caller has already confirmed the
    value IS an array; here `minItems` bounds it (device_run needs argv >= 1)
    and `items.type`, when declared, is checked element by element so a single
    bad element (a number where a string belongs) names its own index rather
    than reaching a shell. An `items` with no declared type accepts anything —
    the same no-blame stance _matches takes on an unknown type keyword."""
    minimum = spec.get("minItems")
    if minimum is not None and len(value) < minimum:
        unit = "item" if minimum == 1 else "items"
        return f"argument {name!r} must have at least {minimum} {unit}, got {len(value)}"
    items = spec.get("items")
    if not isinstance(items, dict):
        return None
    item_type = items.get("type")
    if item_type is None:
        return None
    for index, element in enumerate(value):
        if not _matches(element, item_type):
            return (
                f"argument {name!r}[{index}] must be {_article(item_type)} {item_type}, "
                f"got {json_type_name(element)}"
            )
    return None


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


_SIMPLE_TYPES = frozenset({"string", "integer", "number", "boolean", "array", "object", "null"})


def _foreign_type_matches(value: Any, expected: str) -> bool:
    """Like `_matches`, except a float with no fractional part is accepted
    as an `"integer"` (ruling T7-B): JSON Schema draft 6 onward (and the
    2020-12 vocabulary any current MCP server writes to) defines `integer`
    as "a number with a zero fractional part", so `1.0` is one — `_matches`
    itself stays strict (`type(value) is int`) for core's OWN tools, whose
    schemas this project writes and controls. `bool` is still never an
    integer: `value.is_integer()` is never reached for one, because
    `type(True) is float` is False."""
    if expected == "integer" and type(value) is float and value.is_integer():
        return True
    return _matches(value, expected)


def _validate_foreign(schema: dict, arguments: dict) -> str | None:
    properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    known = ", ".join(sorted(properties)) or "none"
    required = schema.get("required")
    if isinstance(required, list):
        for name in required:
            if isinstance(name, str) and name not in arguments:
                return f"missing required argument {name!r} — this tool takes: {known}"
    # The unknown-argument refusal is skipped when the schema admits keys
    # this reading cannot enumerate — `patternProperties` or `propertyNames`
    # name a WIDER set than `properties` alone, so "not in properties" is not
    # "unknown" (ruling T7-B: `additionalProperties: false` together with
    # `patternProperties` still allows every key a pattern matches).
    if (
        schema.get("additionalProperties") is False
        and "patternProperties" not in schema
        and "propertyNames" not in schema
    ):
        for name in arguments:
            if name not in properties:
                return f"unknown argument {name!r} — this tool takes: {known}"
    for name, value in arguments.items():
        spec = properties.get(name)
        if not isinstance(spec, dict):
            continue
        declared = spec.get("type")
        allowed = (
            [declared]
            if isinstance(declared, str)
            else declared
            if isinstance(declared, list)
            else []
        )
        simple = [t for t in allowed if isinstance(t, str) and t in _SIMPLE_TYPES]
        if (
            simple
            and len(simple) == len(allowed)
            and not any(_foreign_type_matches(value, t) for t in simple)
        ):
            return (
                f"argument {name!r} must be {_article(simple[0])} {' or '.join(simple)}, "
                f"got {json_type_name(value)}"
            )
        enum = spec.get("enum")
        if isinstance(enum, list) and enum and value not in enum:
            choices = ", ".join(json.dumps(v) for v in enum[:20])
            return f"argument {name!r} must be one of {choices}, got {json.dumps(value)}"
    return None


def validate_foreign(schema: Any, arguments: Any) -> str | None:
    """A LENIENT check of arguments against a schema core did not write — an
    MCP server's inputSchema (S37a, plan decision P6).

    It refuses only what it can be sure of: a missing required argument (when
    `required` is the list of strings JSON Schema defines — a draft-03 habit
    like `"required": true`, or any other shape, names nothing this reading
    can be sure is missing), a top-level value of the wrong simple type (a
    whole-number float counts as an `"integer"`), a value outside a declared
    enum, and an unknown argument when the schema says
    `additionalProperties: false` AND does not ALSO admit keys by
    `patternProperties` or `propertyNames`. Everything else JSON Schema can
    say (nested shapes, anyOf, $ref, formats) is the server's to judge, and a
    refusal it sends back is stated to her in its own words. `validate` above
    is for core's own tools and refuses every unknown key: applied to a
    stranger's schema it would refuse calls the server accepts.

    NEVER RAISES (ruling T7-B, structural): a schema shaped in a way this
    reading cannot make sense of is not grounds to refuse a call, or to let
    an exception reach `mcp_call` as "failed unexpectedly" — it is read as
    "not sure", exactly like a schema this function cannot recognise at all,
    and the call reaches the server, which judges its own input."""
    if type(arguments) is not dict:
        return f"the arguments must be a JSON object, got {json_type_name(arguments)}"
    if not isinstance(schema, dict):
        return None
    try:
        return _validate_foreign(schema, arguments)
    except Exception:
        return None
