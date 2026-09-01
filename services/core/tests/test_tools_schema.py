"""schema.validate over the array/items subset the device tools need.

`argv` (device_run) and `capabilities` are arrays of strings, and the kernel
must be able to refuse a bad element BEFORE the executor ever runs — an argv
with a number in it is a call that should never reach a shell. So validate()
grows `items.type` (every element checked, the offending index named) and
`minItems` (device_run needs argv >= 1). DB-free, like the rest of the schema
suite: the validator's whole job is turning "what was wrong" into a stated
reason, and it never raises.
"""
from __future__ import annotations

from app.tools import schema

ARGV_SCHEMA = {
    "type": "object",
    "properties": {
        "argv": {"type": "array", "items": {"type": "string"}, "minItems": 1},
    },
    "required": ["argv"],
    "additionalProperties": False,
}


def test_an_array_of_the_right_element_type_passes():
    assert schema.validate(ARGV_SCHEMA, {"argv": ["ls", "-la"]}) is None


def test_a_wrong_typed_element_is_refused_naming_the_index_and_type():
    problem = schema.validate(ARGV_SCHEMA, {"argv": ["ls", 7]})
    assert problem is not None
    assert "argv" in problem
    assert "1" in problem  # the offending index
    assert "string" in problem  # the expected element type


def test_only_the_first_bad_element_needs_to_be_named():
    problem = schema.validate(ARGV_SCHEMA, {"argv": [1, 2]})
    assert problem is not None
    assert "argv" in problem and "0" in problem


def test_min_items_refuses_an_empty_array():
    problem = schema.validate(ARGV_SCHEMA, {"argv": []})
    assert problem is not None
    assert "argv" in problem and "at least 1" in problem


def test_an_empty_array_is_allowed_without_min_items():
    permissive = {
        "type": "object",
        "properties": {"xs": {"type": "array", "items": {"type": "string"}}},
        "additionalProperties": False,
    }
    assert schema.validate(permissive, {"xs": []}) is None


def test_the_value_must_be_an_array_before_its_items_are_checked():
    problem = schema.validate(ARGV_SCHEMA, {"argv": "ls"})
    assert problem is not None
    assert "argv" in problem and "array" in problem


def test_items_without_a_declared_element_type_accepts_anything():
    permissive = {
        "type": "object",
        "properties": {"xs": {"type": "array", "items": {}}},
        "additionalProperties": False,
    }
    assert schema.validate(permissive, {"xs": [1, "a", True]}) is None
