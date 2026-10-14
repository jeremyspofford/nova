"""The reply-layout instruction is in every chat prompt, last in her own text.

Position beats emphasis for small models (fable-humanize-responses): the
layout block only wins when nothing of hers follows it. An agent's own block
may follow, since it is a separate section of its own.
"""

from app import chat, tools


def test_layout_is_the_last_thing_in_her_prompt():
    prompt = chat.stable_system_prompt("m", tools.tool_names())
    assert prompt.endswith(chat.ANSWER_LAYOUT)


def test_layout_comes_before_an_agent_block():
    prompt = chat.stable_system_prompt("m", tools.tool_names(), agent_block="AGENT BLOCK")
    assert prompt.endswith(chat.ANSWER_LAYOUT + "\n\nAGENT BLOCK")


def test_layout_opens_with_the_answer_and_carries_a_paired_example():
    text = chat.ANSWER_LAYOUT
    assert "Open with the answer itself" in text
    assert "`##` headings" in text
    assert "table" in text
    # The paired example: the shape to use AND the textbook opener to avoid.
    assert "## How to build one" in text
    assert "The term originated in" in text
