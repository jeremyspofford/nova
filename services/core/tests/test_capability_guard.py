"""The capability-claim guard, tested in isolation: pure (text, tools) -> verdict.

capability_claim_check is a pure function — no database, no gateway — so this is
the fast corpus that pins its precision. The expensive failure is a
wrongly-corrected HONEST reply (a false positive makes the guard itself the
liar), so the must-NOT-fire cases below are as load-bearing as the fabrications.

Every case from the S3 walk-fix (T7) brief's calibration section is here, plus
the registry TOGGLE proving the SAME sentence flips verdict on whether the
satisfying tool is actually available — the derived-not-hardcoded property.
"""

from __future__ import annotations

import pytest

from app import guards, tools

# The live registry — the real tool set the running loop exposes. Using it
# (rather than a hand-written list) is the point: the guard reads the tools the
# system actually has, so these tests break the day fetch_url/workspace_* leave
# the registry, which is the intended alarm.
ALL_TOOLS = tools.tool_names()


def tgt(correction) -> list:
    return [claim.target for claim in correction.claims]


# -- MUST FIRE (the satisfying tool is registered) -------------------------
#
# The exact owner reply plus every calibration case from the brief. Each denies
# a GENERAL ability whose tool is in the live registry, so each is a false
# denial the guard must contradict.

MUST_FIRE = [
    (
        "owner_exact_reply",
        "I cannot access external websites or real-time data, including bigblueview.com.",
        "fetch_url",
    ),
    ("cant_browse_the_web", "I can't browse the web.", "fetch_url"),
    ("unable_to_access_the_internet", "I'm unable to access the internet.", "fetch_url"),
    (
        "capabilities_dont_include_web_browsing",
        "My capabilities don't include web browsing.",
        "fetch_url",
    ),
    ("no_ability_to_fetch_urls", "I don't have the ability to fetch URLs.", "fetch_url"),
    ("cant_read_files", "I can't read files.", "workspace_read_file"),
    ("not_able_to_save_files", "I'm not able to save files.", "workspace_write_file"),
    # S10a-3: her model tools.
    ("cant_download_models", "I can't download models.", "model_pull"),
    ("unable_to_install_a_model", "I'm unable to install a new model.", "model_pull"),
    ("cant_search_for_models", "I can't search for models.", "model_catalog_search"),
    ("cant_list_installed_models", "I cannot list the installed models.", "model_catalog_search"),
    ("cant_remove_models", "I can't remove models.", "model_remove"),
    (
        "unable_to_delete_installed_model",
        "I'm unable to delete an installed model.",
        "model_remove",
    ),
    ("cant_check_for_updates", "I can't check for updates to a model.", "model_check_update"),
    ("cant_update_models", "I cannot update models.", "model_check_update"),
    # S9: the reminder tools are registered, so disowning them is a false denial.
    ("cant_set_reminders", "I can't set reminders.", "create_timer"),
    ("unable_to_remind_you", "I'm unable to remind you later.", "create_timer"),
    # "yet" is a denial of an unshipped feature, not a condition on this call.
    ("cant_set_reminders_yet", "I can't set reminders yet.", "create_timer"),
    ("cant_set_reminder_for_you", "I can't set a reminder for you.", "create_timer"),
    (
        "scheduling_tasks_trailing_denial",
        "Scheduling tasks is not something I can do.",
        "create_timer",
    ),
    # S40: her machine tools are registered, so disowning them is a false denial.
    (
        "cant_see_where_models_run",
        "I can't see which machine your models run on.",
        "machine_status",
    ),
    (
        "unable_to_check_where_models_run",
        "I'm unable to check where the models are running.",
        "machine_status",
    ),
    (
        "no_access_to_machine_status",
        "I don't have access to the status of your machines.",
        "machine_status",
    ),
    # Ruling C9: T7's denial, the sentence the checks case scores — the verb
    # comes BEFORE the noun ("which machine runs my models").
    (
        "cant_check_which_machine_runs_my_models",
        "I can't check which machine runs my models.",
        "machine_status",
    ),
    (
        "cant_switch_models_off_on_a_machine",
        "I can't switch off chat models on a machine.",
        "machine_configure",
    ),
    (
        "not_able_to_stop_a_machine_serving",
        "I'm not able to stop a machine from running models.",
        "machine_configure",
    ),
    (
        "changing_which_machine_trailing",
        "Changing which machine runs the models is not something I can do.",
        "machine_configure",
    ),
    # S40 fix wave A3: the GENERAL forms the tightened pattern keeps.
    (
        "cant_turn_off_models_on_any_machine",
        "I can't turn off chat models on any machine.",
        "machine_configure",
    ),
    (
        "unable_to_stop_machines_serving",
        "I'm unable to stop machines from serving models.",
        "machine_configure",
    ),
    # S47: her setup QR tool.
    # I3 (review fix round 1): the noun must be QUALIFIED (setup or pairing),
    # never a bare "QR code(s)".
    ("cant_make_setup_qr_codes", "I can't make setup QR codes.", "show_setup_qr"),
    ("cant_show_a_pairing_card", "I'm unable to show you a pairing card.", "show_setup_qr"),
    ("cant_pair_a_laptop", "I cannot pair your laptop.", "show_setup_qr"),
    ("cant_put_myself_on_a_phone", "I can't put myself on your phone.", "show_setup_qr"),
    # S42a: Nova's agent runs on Windows and macOS now, so disowning either is
    # the S12 failure again (device_run is registered).
    ("cant_access_windows_machines", "I can't access Windows machines.", "device_run"),
    (
        "unable_to_run_commands_on_a_mac",
        "I'm unable to run commands on a Mac computer.",
        "device_run",
    ),
    ("cannot_control_macs", "I cannot control Macs.", "device_run"),
    # S42b: updating her agents is machine_update's.
    ("cant_update_the_agents", "I can't update the agents on your machines.", "machine_update"),
    ("unable_to_upgrade_novad", "I'm unable to upgrade novad.", "machine_update"),
    ("cant_update_your_agents", "I can't update your agents.", "machine_update"),
    (
        "no_ability_to_update_agents",
        "I don't have the ability to update agents.",
        "machine_update",
    ),
    ("not_able_to_update_any_agent", "I'm not able to update any agent.", "machine_update"),
    ("cant_update_agents_for_you", "I can't update agents for you.", "machine_update"),
    ("cant_upgrade_novad_yet", "I can't upgrade novad yet.", "machine_update"),
    (
        "updating_agents_trailing_denial",
        "Updating agents isn't something I can do.",
        "machine_update",
    ),
]


@pytest.mark.parametrize("label,reply,tool", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_must_fire_when_the_tool_is_registered(label, reply, tool):
    correction = guards.capability_claim_check(reply, ALL_TOOLS)
    assert correction is not None, f"{label!r} should have fired but did not"
    assert tgt(correction) == [tool]
    # The correction NAMES the real tool, derived from the passed registry.
    assert tool in correction.text, correction.text
    assert correction.text.startswith("Correction: I can do that")


# -- MUST NOT FIRE (has the tools; still honest) ---------------------------
#
# A capability with no registered tool is HONEST (there is genuinely no such
# tool). A specific failed attempt is an honest result about ONE try, not a
# denial of the ability. A hedge/question asserts no inability. Correcting any
# of these makes the guard the liar.

MUST_NOT_FIRE = [
    # No registered tool -> the denial is HONEST (proven by passing the REAL
    # registry, which has no email/phone/bank tool).
    ("no_tool_send_emails", "I can't send emails."),
    ("no_tool_phone_calls", "I can't make phone calls."),
    ("no_tool_bank_account", "I don't have access to your bank account."),
    # A SPECIFIC failed attempt, not an ability denial (the precision crux).
    ("specific_404", "I couldn't fetch that page — it returned a 404."),
    ("specific_missing_file", "I can't find a file named report.md."),
    ("specific_url_didnt_load", "That URL didn't load."),
    # S9: the store's own refusal, relayed — one time, not the ability.
    (
        "specific_reminder_in_the_past",
        "I can't set a reminder for a time that has already passed.",
    ),
    ("specific_reminder_past_tense", "I couldn't set the reminder — the time had passed."),
    # S9: the tools' own refusals RELAYED, and a memory statement — a
    # condition/target tail on the ability phrase. A correction under any of
    # these would make the guard the liar (review of T2, 2026-09-07).
    (
        "relayed_no_timezone_until",
        "I can't set a reminder until a timezone is set for this instance — it is set in "
        "Settings → General.",
    ),
    (
        "relayed_no_timezone_absolute",
        "I can't set a reminder at an absolute time yet: no timezone is set for this instance.",
    ),
    ("relayed_past_schedule", "I can't schedule anything for a time that has already passed."),
    ("specific_reminder_yesterday", "I can't set a reminder for yesterday."),
    (
        "specific_reminder_quoted_object_relay",
        "I can't set a reminder for 'stretch' until a timezone is set.",
    ),
    (
        "remind_about_past_relay",
        "I can't remind you about that — the time you gave has already passed.",
    ),
    (
        "memory_not_a_timer",
        "I can't remind you of what you said last week; my memory search found nothing.",
    ),
    # A hedge / conditional / question describes what MIGHT or WOULD be, not what
    # is; a question asserts nothing at all.
    ("hedge_guarantee", "I can't guarantee that's accurate."),
    ("hedge_might_not_reach", "I might not be able to reach that site."),
    ("question_would_you_like", "Would you like me to try?"),
    # An honest plain reply carries no denial.
    ("plain_reply", "The capital of France is Paris."),
    # S40: no wake tool yet (S46) — honest. A scope limit — honest. A past,
    # specific failed switch — an honest report of one try.
    ("honest_no_wake_tool", "I can't wake machines up."),
    ("machine_scope_other_network", "I can't check where models run on another network."),
    (
        "machine_specific_past",
        "I couldn't switch off chat models on hub — the gateway refused.",
    ),
    # S40 fix wave A3: machine_configure's own refusals and a failed switch,
    # RELAYED in the present tense about ONE machine ("that machine", "this
    # machine" — the words the tile and machine_status use for hub). The
    # switch really did not happen; "Correction: I can do that" here would be
    # the guard lying at the exact moment she is telling the truth.
    (
        "relayed_no_such_machine",
        "I can't switch off chat models on that machine — the gateway has no machine named dell.",
    ),
    (
        "relayed_refused_switch",
        "I'm unable to stop this machine from running chat models: the gateway refused the change.",
    ),
    (
        "relayed_unreachable_right_now",
        "I can't switch off chat models on this machine right now — the gateway couldn't be "
        "reached.",
    ),
    (
        "relayed_not_confirmed",
        "I can't turn off serving for your machine — hub's switch is not confirmed set.",
    ),
    (
        "relayed_until_back",
        "I can't switch off chat models on this machine until the gateway is back.",
    ),
    (
        "relayed_the_machine_until",
        "I can't stop the machine from running models until the gateway is reachable.",
    ),
    # S47: true today — joining a machine to the tailnet is S43, not built.
    ("scope_tailnet_join", "I can't add machines to your tailnet."),
    ("no_native_app_exists", "I can't install a native app — there isn't one yet."),
    # I3 (review fix round 1): a denial qualified as a PRESENT STATE is
    # honest, never a general capability denial.
    (
        "qr_present_state_no_address",
        "I can't show you the QR code right now: Nova has no address another device can reach.",
    ),
    (
        "pairing_card_present_state_reason",
        "I can't show a pairing card right now because the tailnet sidecar is NeedsLogin.",
    ),
    # a bare, unqualified "QR code(s)" is never the setup-QR ability.
    ("qr_for_wifi", "I can't make QR codes for Wi-Fi networks."),
    ("qr_for_arbitrary_link", "I can't generate a QR code for an arbitrary link."),
    # "install" dropped from the phone row — installing IS on the operator,
    # via Safari's Share menu, never Nova.
    (
        "install_native_app_is_hers_not_nova",
        "I can't install Nova on your phone for you: you add it from Safari's Share menu.",
    ),
    # S42a: an honest report about ONE machine, or a past attempt — never a
    # denial of the ability.
    ("that_windows_machine_is_offline", "I can't reach that Windows machine — it's offline."),
    ("past_couldnt_reach_the_windows_pc", "I couldn't reach your Windows PC just now."),
    # S42a final review I1: a Windows machine or a Mac cannot serve models
    # until S44, so "I can't use one for models yet" is TRUE. The verbs "use"
    # and "work with" accept any purpose, which is why they are not in the
    # device_run row: correcting these with "I have a tool for it
    # (device_run)" would make the guard the liar.
    (
        "no_windows_machines_for_models_yet",
        "I can't use Windows machines to run models yet; that arrives with a later update.",
    ),
    ("no_windows_pc_as_a_model_server_yet", "I can't use a Windows PC as a model server yet."),
    ("no_macs_for_local_models_yet", "I can't use Macs for local models yet."),
    # S42b: one agent's present state, and a stated reason — honest reports, not the ability.
    (
        "update_offline_right_now",
        "I can't update the agent on the laptop right now — it's offline.",
    ),
    (
        "update_hand_started_because",
        "I can't update eval_laptop's agent because it was started by hand.",
    ),
    # S42b (Task 23): machine_update's own cannots, relayed — about one agent, a
    # kind of agent, a place or a moment. The correction is REPLACE-class, so
    # each of these corrected would drop a true reply for "I can do that".
    (
        "update_the_agent_hand_started_dash",
        "I can't update the agent on eval_laptop — it was started by hand, so nothing "
        "would start a new build.",
    ),
    ("update_the_agent_singular", "I can't update the agent."),
    ("update_its_agent_offline", "I can't update its agent: it is offline."),
    ("update_agents_started_by_hand", "I can't update agents that were started by hand."),
    (
        "update_agents_on_named_machines",
        "I can't update the agents on minipc and eval_laptop: both are offline.",
    ),
    # A machine's own name is never the general place, even where the denial
    # ends there: minipc's agent may be the one that cannot take the build.
    ("update_agents_on_one_named_machine", "I can't update the agents on minipc."),
    (
        "update_agents_while_in_flight",
        "I can't update your agents while another update is in flight.",
    ),
    (
        "update_agents_yet_no_build",
        "I can't update your agents yet: the hub has no agent build to send.",
    ),
    ("update_agents_on_32_bit_machines", "I can't update agents on 32-bit machines."),
    (
        "update_novad_on_one_machine",
        "I can't update novad on eval_laptop: it predates Nova-managed updates.",
    ),
    ("update_agents_in_a_replay", "I can't update agents during an eval replay."),
    ("update_the_hubs_agent", "I can't update the hub's agent — 'hub' names the bundled engine."),
    ("update_agents_on_other_machines", "I can't update agents on other machines."),
    (
        "update_agents_to_another_build",
        "I can't update your agents to a build the hub does not have.",
    ),
]


@pytest.mark.parametrize("label,reply", MUST_NOT_FIRE, ids=[c[0] for c in MUST_NOT_FIRE])
def test_must_not_fire_on_honest_replies(label, reply):
    assert guards.capability_claim_check(reply, ALL_TOOLS) is None, (
        f"{label!r} was wrongly corrected — a false positive makes the guard the liar"
    )


def test_the_correction_text_itself_never_fires():
    """Self-reference: running the guard on its own honest correction must be
    clean — the correction is worded to carry no inability lead."""
    correction = guards.capability_claim_check("I can't browse the web.", ALL_TOOLS)
    assert correction is not None
    assert guards.capability_claim_check(correction.text, ALL_TOOLS) is None


# -- the registry TOGGLE: derived-not-hardcoded ----------------------------


def test_the_same_denial_fires_only_when_the_tool_is_registered():
    """'I can't browse the web' is a FALSE denial when fetch_url is available and
    an HONEST one when it is not — the verdict flips on the live tool set alone,
    which is the whole derived-not-hardcoded point (CLAUDE.md)."""
    reply = "I can't browse the web."
    fired = guards.capability_claim_check(reply, ["fetch_url"])
    assert fired is not None
    assert tgt(fired) == ["fetch_url"]
    # fetch_url removed from the registry -> the denial is honest -> silent.
    without_fetch = [t for t in ALL_TOOLS if t != "fetch_url"]
    assert guards.capability_claim_check(reply, without_fetch) is None
    # And with no tools at all.
    assert guards.capability_claim_check(reply, []) is None


# -- edges precision demands -----------------------------------------------


def test_an_empty_or_blank_reply_never_fires():
    assert guards.capability_claim_check("", ALL_TOOLS) is None
    assert guards.capability_claim_check("   \n ", ALL_TOOLS) is None


def test_a_past_tense_or_other_subject_denial_is_not_a_capability_claim():
    # Past tense is a report of one attempt, not a denial of the ability.
    assert guards.capability_claim_check("I couldn't browse the web.", ALL_TOOLS) is None
    # Another subject — not the model disowning its OWN capability.
    assert guards.capability_claim_check("You can't browse the web from here.", ALL_TOOLS) is None
    assert guards.capability_claim_check("It cannot access websites.", ALL_TOOLS) is None


def test_the_trailing_denial_form_fires():
    """'<capability> is not something I can do' — the capability comes first."""
    correction = guards.capability_claim_check("Web browsing is not something I can do.", ALL_TOOLS)
    assert correction is not None
    assert tgt(correction) == ["fetch_url"]


def test_the_guard_is_pure_same_inputs_same_verdict():
    reply = "I can't browse the web."
    first = guards.capability_claim_check(reply, ALL_TOOLS)
    second = guards.capability_claim_check(reply, ALL_TOOLS)
    assert (first is None) == (second is None)
    assert first is not None
    assert tgt(first) == tgt(second)
    assert first.text == second.text


@pytest.mark.parametrize(
    "reply",
    [
        "I can't \\((((.md and [unbalanced",
        "cannot cannot cannot",
        "创建 web browsing 文件",  # non-ascii around a real phrase
        "\n\n\n",
        "I can't " + "web browsing " * 200,
    ],
)
def test_the_matcher_never_raises_on_odd_input(reply):
    # We do not care about the verdict here — only that it returns cleanly.
    guards.capability_claim_check(reply, ALL_TOOLS)


# -- the agent tools (S12, 2026-09-08) --------------------------------------
#
# Added from a live walk, not from imagination: asked to hand a task to the
# agent she had just created, she answered "delegating to an agent needs a
# delegate_to_agent tool, and that capability isn't in my toolset right now"
# — with delegate_to_agent in her advertised list AND the roster line naming
# the agent in the same prompt. The prompt carried the truth and she denied
# it anyway, which is the whole reason this table exists beside the prompt.
@pytest.mark.parametrize(
    ("reply", "tool"),
    [
        (
            "I can't do that one — delegating to an agent needs a tool, "
            "so I can't hand off work to coder.",
            "delegate_to_agent",
        ),
        ("I cannot delegate to an agent right now.", "delegate_to_agent"),
        ("I'm unable to hand this off to coder.", "delegate_to_agent"),
        ("I don't have the ability to create an agent.", "create_agent"),
        ("I can't list your agents.", "list_agents"),
        ("I am not able to delete an agent.", "delete_agent"),
    ],
)
def test_a_denied_agent_capability_is_corrected_and_names_the_tool(reply, tool):
    correction = guards.capability_claim_check(reply, ALL_TOOLS)
    assert correction is not None, f"a false denial of {tool} must be corrected"
    assert tool in tgt(correction)
    assert tool in correction.text


@pytest.mark.parametrize(
    "reply",
    [
        # Backed relays and offers assert no inability.
        "I asked coder to write it and it did.",
        "Want me to delegate that to coder?",
        "I'll delegate it to coder and report back.",
        # A specific failure, not a disowned capability.
        "I couldn't delegate to coder — it is over its monthly cap.",
    ],
)
def test_honest_delegation_sentences_are_left_alone(reply):
    assert guards.capability_claim_check(reply, ALL_TOOLS) is None


def test_an_agent_denying_a_tool_outside_its_subset_is_honest():
    """The symmetry the persona feed buys: the SAME sentence is a lie from
    Nova (who holds the tool) and the truth from an agent (whose subset never
    contains delegate_to_agent — agents.validate_spec refuses it), because the
    verdict reads the live list the caller was actually given."""
    subset = ["workspace_read_file", "workspace_write_file", "workspace_list_files"]
    assert guards.capability_claim_check("I can't delegate to an agent.", subset) is None
    assert guards.capability_claim_check("I can't delegate to an agent.", ALL_TOOLS) is not None


def test_the_agent_corrections_are_clean_over_themselves():
    for reply in ("I can't delegate to an agent.", "I can't create an agent."):
        correction = guards.capability_claim_check(reply, ALL_TOOLS)
        assert correction is not None
        assert guards.capability_claim_check(correction.text, ALL_TOOLS) is None


# -- a scope limit is not a disowned capability (S12, 2026-09-08) -----------
#
# From the live walk: an agent is contained to its own folder, so "I can't
# write files outside my folder" is TRUE — the tool exists and
# _resolve_within refuses the path. Correcting it would tell the owner the
# agent can write anywhere, which is the opposite of the fact. Nova's root
# is contained too, so the same sentence is protected from her.
#
# THE LIST MOVED 6 -> 11 (2026-09-09). The first fix read only the 40
# characters IMMEDIATELY after the capability phrase, so it excused the six
# phrasings below that happen to put the scope word there and CORRECTED every
# honest containment sentence with any words in between. Measured over these
# eleven that day: 9 silent, 2 corrected into "Correction: I can do that — I
# have a tool for it (workspace_write_file)", i.e. the guard telling the owner
# she can write anywhere. The two that were wrong are #2 and #3 and they are
# pinned here by name; the window is gone (guards._denial_tail) and all
# eleven now measure silent. This list IS the re-measurement — a phrasing
# added here is a phrasing someone checked.
@pytest.mark.parametrize(
    "reply",
    [
        "I can't write files outside my workspace.",
        # The two live FALSE CORRECTIONS the 40-char window left behind:
        "I can't write files to paths outside the workspace.",
        "I can't write files there — /etc/nova/notes.md is outside my workspace.",
        "I can't list files outside my folder.",
        "I cannot read files outside agents/coder/.",
        "I can't write files anywhere except my own folder.",
        "I'm unable to read files from another person's workspace.",
        "I can't write files elsewhere.",
        "I can't search the web or list files from external sources.",
        "I can't write files anywhere other than my workspace root.",
        "I can't create files beyond my sandbox.",
    ],
)
def test_a_scope_limit_on_a_capability_is_honest(reply):
    assert guards.capability_claim_check(reply, ALL_TOOLS) is None, (
        "a truthful containment sentence was corrected into 'I can do that' — "
        "the guard is the liar, the worse of the two failures"
    )


@pytest.mark.parametrize(
    "reply",
    [
        "I can't list files.",
        "I can't write files.",
        "I'm unable to read a file for you.",
        # 2026-09-09: the tail is THIS denial's, and it ends where the NEXT
        # denial starts — the scope word belongs to the second clause's
        # denial, so the first is still the flat false denial it looks like.
        "I can't write files and I can't work outside the sandbox.",
    ],
)
def test_a_bare_denial_of_a_held_capability_is_still_corrected(reply):
    """The qualifier must excuse a SCOPE, never the capability itself."""
    assert guards.capability_claim_check(reply, ALL_TOOLS) is not None


# -- the trailing denial forms (2026-09-09) --------------------------------
#
# The walk's OWN sentence did not reach the guard. She said "delegating to an
# agent needs a delegate_to_agent tool, and that capability isn't in my
# toolset right now" while HOLDING delegate_to_agent, and every denial lead in
# the set is a first-person present ability form ("I can't", "I'm unable to",
# "my capabilities don't include") — none of which that sentence contains. The
# 2026-09-08 fix caught her only because a LATER clause said "so I can't hand
# off work to coder": a second phrasing, not the one she used. A denial does
# not stop being a denial for being said about a possession rather than an
# ability, so the whole negated-copula family is read now.


@pytest.mark.parametrize(
    ("reply", "tool"),
    [
        # THE WALK, verbatim (2026-09-08) — the sentence the guard missed.
        (
            "delegating to an agent needs a delegate_to_agent tool, and that capability "
            "isn't in my toolset right now",
            "delegate_to_agent",
        ),
        ("Delegating to an agent is not in my toolset.", "delegate_to_agent"),
        ("Delegating to an agent is not a capability I have.", "delegate_to_agent"),
        ("Web browsing isn't available to me.", "fetch_url"),
        ("Reading files is not one of my tools.", "workspace_read_file"),
        ("Listing files isn't among my tools.", "workspace_list_files"),
        ("Creating an agent is not part of my capabilities.", "create_agent"),
        ("Writing files isn't something I'm able to do.", "workspace_write_file"),
        # The original form, still read.
        ("Scheduling tasks is not something I can do.", "create_timer"),
    ],
)
def test_a_trailing_denial_of_a_held_capability_is_corrected(reply, tool):
    correction = guards.capability_claim_check(reply, ALL_TOOLS)
    assert correction is not None, "a trailing denial is a denial"
    assert tool in tgt(correction)
    assert tool in correction.text


def test_a_trailing_denial_is_not_read_as_its_own_scope_limit():
    """A trailing denial's own "not in my toolset" is the DENIAL, not a scope
    on the capability — the tail a scope word may live in ends where the next
    denial begins, so the two cannot be confused for each other."""
    fired = guards.capability_claim_check("Reading files is not in my toolset.", ALL_TOOLS)
    assert fired is not None and tgt(fired) == ["workspace_read_file"]
    # ...while a REAL scope qualifier in front of the same denial is honest.
    assert (
        guards.capability_claim_check(
            "Writing files outside my workspace is not something I can do.", ALL_TOOLS
        )
        is None
    )


def test_the_trailing_forms_stay_derived_from_the_live_tool_set():
    """The same sentence flips on the registry alone, exactly as the lead
    forms do — the trailing family is not a second, hardcoded verdict."""
    reply = "Delegating to an agent isn't in my toolset."
    assert guards.capability_claim_check(reply, ["delegate_to_agent"]) is not None
    assert guards.capability_claim_check(reply, []) is None


def test_the_trailing_correction_is_clean_over_itself():
    correction = guards.capability_claim_check(
        "Delegating to an agent isn't in my toolset.", ALL_TOOLS
    )
    assert correction is not None
    assert guards.capability_claim_check(correction.text, ALL_TOOLS) is None


# -- deleting a file (S16) -------------------------------------------------
#
# The sentence that started the slice, said to the owner on 2026-09-11 when he
# asked her to delete a file: "there is no delete operation in my toolbox."
# It was TRUE then. With workspace_delete registered it is a false denial, and
# this guard is what refuses it.


def test_the_owners_exact_no_delete_reply_is_contradicted():
    reply = "I can list it and read it, but there is no delete operation in my toolbox."
    correction = guards.capability_claim_check(reply, ALL_TOOLS)
    assert correction is not None
    assert tgt(correction) == ["workspace_delete"]


@pytest.mark.parametrize(
    "reply",
    [
        "I can't delete files.",
        "I'm unable to delete files.",
        "I don't have the ability to remove files.",
        "My capabilities don't include deleting files.",
        "Deleting files isn't in my toolset.",
        "Removing files is not something I can do.",
    ],
)
def test_a_general_denial_of_deletion_is_contradicted(reply):
    correction = guards.capability_claim_check(reply, ALL_TOOLS)
    assert correction is not None
    assert tgt(correction) == ["workspace_delete"]


def test_the_delete_denial_stays_derived_from_the_live_tool_set():
    reply = "I can't delete files."
    assert guards.capability_claim_check(reply, ["workspace_delete"]) is not None
    assert guards.capability_claim_check(reply, []) is None


@pytest.mark.parametrize(
    "reply",
    [
        # a SPECIFIC failed attempt, not a denial of the ability
        "I couldn't delete groceries.md — there is nothing at that path.",
        "I can't delete groceries.md because it is a symbolic link.",
        # a true statement about containment
        "I can't delete files outside my workspace.",
        # a question, a future form, another subject
        "Would you like me to delete those files?",
        "I'll delete them once you confirm.",
        "You can't delete files from here.",
    ],
)
def test_an_honest_sentence_about_deletion_is_left_alone(reply):
    assert guards.capability_claim_check(reply, ALL_TOOLS) is None


def test_the_delete_correction_is_clean_over_itself():
    correction = guards.capability_claim_check("I can't delete files.", ALL_TOOLS)
    assert correction is not None
    assert guards.capability_claim_check(correction.text, ALL_TOOLS) is None


def test_a_machine_denial_is_false_only_while_machine_status_is_registered():
    """Ruling C9 / T7's armed test: the denial the checks case invites fires
    with the live toolset and is HONEST the moment machine_status is not held
    — the verdict is derived from the toolset, never from a list."""
    denial = "I can't check which machine runs my models."
    fired = guards.capability_claim_check(denial, ALL_TOOLS)
    assert fired is not None and tgt(fired) == ["machine_status"]
    without = [name for name in ALL_TOOLS if name != "machine_status"]
    assert guards.capability_claim_check(denial, without) is None


def test_an_update_denial_is_false_only_while_machine_update_is_registered():
    """S42b: derived from the live tool set, like every row — the day
    machine_update leaves the registry, "I can't update your agents" is true
    again and the row is silent by itself."""
    reply = "I can't update your agents."
    fired = guards.capability_claim_check(reply, ALL_TOOLS)
    assert fired is not None and tgt(fired) == ["machine_update"]
    without = [t for t in ALL_TOOLS if t != "machine_update"]
    assert guards.capability_claim_check(reply, without) is None
    assert guards.capability_claim_check(fired.text, ALL_TOOLS) is None


# -- her MCP client (S37a) ---------------------------------------------------
#
# Connecting to MCP servers and using MCP tools are GENERAL abilities, held
# the moment mcp_connect and mcp_call are registered. Plural or indefinite
# nouns only, like every row: "the MCP server" names one thing, and a NAMED
# server's denial ("I can't access GitHub") is server_denial_check's, which
# reads the live server list (test_mcp_guards.py).


def test_the_mcp_abilities_are_hers_while_the_tools_are_registered():
    correction = guards.capability_claim_check("I can't connect to MCP servers.", ALL_TOOLS)
    assert correction is not None and "mcp_connect" in correction.text
    correction = guards.capability_claim_check("I'm unable to use MCP tools.", ALL_TOOLS)
    assert correction is not None and "mcp_call" in correction.text
    assert (
        guards.capability_claim_check("I can't connect to the MCP server right now.", ALL_TOOLS)
        is None
    )


def test_the_mcp_denials_are_honest_without_the_tools():
    without = [name for name in ALL_TOOLS if name not in ("mcp_connect", "mcp_call")]
    assert guards.capability_claim_check("I can't connect to MCP servers.", without) is None
    assert guards.capability_claim_check("I'm unable to use MCP tools.", without) is None


def test_the_mcp_corrections_are_clean_over_themselves():
    for reply in ("I can't connect to MCP servers.", "I'm unable to use MCP tools."):
        correction = guards.capability_claim_check(reply, ALL_TOOLS)
        assert correction is not None
        assert guards.capability_claim_check(correction.text, ALL_TOOLS) is None


# Fix round 1 (review of 77260997, ruling T12-B — S38's G1 shape): a denial
# QUALIFIED by what follows the object is a true limit, never the general
# ability. capability_claim is REPLACE-class, so a fire here stored only
# "Correction: I can do that" in place of a true sentence — the store refuses
# anything but http(s). The first phrasing is the reviewer's, verbatim; the
# rest cover each family it named (stdio, OAuth, no URL, a server not yet
# connected) and each qualifier the local cut reads.
MCP_QUALIFIED_LIMITS = [
    "I can't connect to MCP servers that run over stdio; I can only connect over HTTP.",
    "I can't connect to MCP servers which only speak stdio.",
    "I can't connect to MCP servers that need OAuth to sign in.",
    "I'm unable to connect to MCP servers requiring an OAuth login.",
    "I can't connect to an MCP server without a URL.",
    "I can't use MCP tools on a server you haven't connected yet.",
    "I can't connect to MCP servers over a local socket.",
    "I can't use MCP servers via the desktop app's config file.",
    "I can't connect to MCP servers using client certificates.",
    "I can't use MCP tools through a server that isn't connected.",
    "I can't connect to MCP servers behind a login page.",
    "I can't use MCP tools unless a server is connected.",
    "I can't connect to MCP servers needing a browser sign-in.",
    "I can't connect to MCP servers, which only run locally on your laptop.",
    "I can't connect to new MCP servers right now: the network is down.",
]


@pytest.mark.parametrize("reply", MCP_QUALIFIED_LIMITS)
def test_a_qualified_mcp_limit_is_honest(reply):
    assert guards.capability_claim_check(reply, ALL_TOOLS) is None, (
        "a true qualified limit was replaced by 'I can do that' — the guard is the liar"
    )


@pytest.mark.parametrize(
    ("reply", "tool"),
    [
        ("I can't connect to MCP servers.", "mcp_connect"),
        ("I'm not able to connect to new MCP servers.", "mcp_connect"),
        ("Connecting to MCP servers isn't something I can do.", "mcp_connect"),
        ("I can't use MCP tools.", "mcp_call"),
        ("I'm unable to use any MCP servers, so I can't check CI.", "mcp_call"),
    ],
)
def test_a_bare_mcp_denial_is_still_corrected(reply, tool):
    correction = guards.capability_claim_check(reply, ALL_TOOLS)
    assert correction is not None and tool in tgt(correction), reply


# -- T6 (local-context epic, 2026-10-09): a POSSESSION denial of her browser --
#
# Turn d4f59914 (dell:qwen3:8b): "I don't have an internal browser or IDE (like
# VS Code) embedded in my architecture" while browser_open was registered, and
# nothing fired: _DENIAL_LEAD reads only "don't have the ability/access to", so
# a first-person denial of HAVING a browser never reached a capability row.
#
# Criteria (RED 2026-10-09):
#   C1 a first-person, present possession denial of a browser — "I don't have"
#      / "I do not have" + a/an/any + at most two words + browser — draws a
#      capability correction naming browser_open while browser_open is in the
#      live tool list; the owner's exact d4f59914 sentence is one of them.
#   C2 derived: the SAME sentences are silent when browser_open is not in the
#      tool list (and with no tools at all).
#   C3 precision: another subject, a past form, a hedge, a specific browser
#      that is not hers ("your browser's", "the browser history"), a stated
#      present state ("open right now") — each a minimal edit of a firing
#      sentence — is silent. Pinned as PAIRS so each honest form is checked
#      against a sentence that does fire.
#   C4 the correction over itself is clean (self-reference).

BROWSER_POSSESSION_DENIALS = [
    (
        "d4f59914_exact",
        "I don't have an internal browser or IDE (like VS Code) embedded in my architecture.",
    ),
    ("dont_have_a_browser", "I don't have a browser."),
    ("do_not_have_a_web_browser", "I do not have a web browser."),
    ("dont_have_any_built_in_browser", "I don't have any built-in browser."),
    ("curly_apostrophe", "I don’t have a browser I can use."),
]


@pytest.mark.parametrize(
    "label,reply",
    BROWSER_POSSESSION_DENIALS,
    ids=[c[0] for c in BROWSER_POSSESSION_DENIALS],
)
def test_t6_c1_a_possession_denial_of_her_browser_is_corrected(label, reply):
    correction = guards.capability_claim_check(reply, ALL_TOOLS)
    assert correction is not None, f"{label!r}: a false denial of browser_open went uncorrected"
    assert "browser_open" in tgt(correction)
    assert "browser_open" in correction.text


@pytest.mark.parametrize(
    "label,reply",
    BROWSER_POSSESSION_DENIALS,
    ids=[c[0] for c in BROWSER_POSSESSION_DENIALS],
)
def test_t6_c2_the_possession_denial_flips_on_the_live_tool_list(label, reply):
    assert guards.capability_claim_check(reply, ["browser_open"]) is not None, label
    without = [t for t in ALL_TOOLS if t != "browser_open"]
    correction = guards.capability_claim_check(reply, without)
    assert correction is None or "browser_open" not in tgt(correction), label
    assert guards.capability_claim_check(reply, []) is None, label


# (label, a sentence that fires, its minimal honest edit)
BROWSER_POSSESSION_PAIRS = [
    ("other_subject_you", "I don't have a browser.", "You don't have a browser."),
    ("other_subject_it", "I don't have a web browser.", "It doesn't have a web browser."),
    (
        "other_subject_machine",
        # T6 VERIFY 2 ruling: "installed" after "browser" is no longer on the
        # allowlist (it admits a place: "installed on your Mac"), so the
        # firing side is the bare head form.
        "I don't have a browser.",
        "The Dell doesn't have a browser installed.",
    ),
    ("past_didnt", "I don't have a browser.", "I didn't have a browser open earlier."),
    ("past_did_not", "I do not have a browser.", "I did not have a browser before this update."),
    ("hedge_might", "I don't have a browser.", "I might not have a browser available."),
    (
        "his_browser_not_hers",
        "I don't have a browser.",
        "I don't have your browser's saved passwords.",
    ),
    (
        "the_browser_history",
        "I don't have a browser.",
        "I don't have the browser history you mean.",
    ),
    (
        "present_state",
        "I don't have a browser.",
        "I don't have a browser page open right now.",
    ),
]


@pytest.mark.parametrize(
    "label,fires,honest", BROWSER_POSSESSION_PAIRS, ids=[c[0] for c in BROWSER_POSSESSION_PAIRS]
)
def test_t6_c3_an_honest_edit_of_a_possession_denial_is_left_alone(label, fires, honest):
    correction = guards.capability_claim_check(fires, ALL_TOOLS)
    assert correction is not None and "browser_open" in tgt(correction), (
        f"{label!r}: the first-person form {fires!r} must fire for the pair to mean anything"
    )
    assert guards.capability_claim_check(honest, ALL_TOOLS) is None, (
        f"{label!r}: {honest!r} was wrongly corrected — the guard would be the liar"
    )


def test_t6_c4_the_browser_correction_is_clean_over_itself():
    correction = guards.capability_claim_check(BROWSER_POSSESSION_DENIALS[0][1], ALL_TOOLS)
    assert correction is not None
    assert guards.capability_claim_check(correction.text, ALL_TOOLS) is None


def test_t6_c4_the_possession_row_fires_only_after_its_own_lead():
    """The row carries its own "I don't/do not have" lead: "a browser" after a
    DIFFERENT lead is not a possession denial, and stays silent."""
    honest = "I can't open that page because I have a browser extension blocking it."
    assert guards.capability_claim_check(honest, ALL_TOOLS) is None


# T6 VERIFY gap (2026-10-09): "browser" as a MODIFIER of a following noun, a
# compound ("browser-based"), a browser in a stated state or place ("open on
# your Mac"), or after a preference adjective ("favorite browser") is not a
# denial that she HAS a browser — each is an honest reply while browser_open is
# registered. Orchestrator ruling: the row fires only when "browser" is the
# HEAD of the noun phrase she says she lacks.
BROWSER_MODIFIER_HONEST = [
    ("tab_open_on_phone", "I don't have a browser tab open on your phone."),
    ("extension_installed", "I don't have a browser extension installed for that."),
    ("session_logged_in", "I don't have a browser session logged into your bank."),
    ("any_cookies", "I don't have any browser cookies from your account."),
    ("profile_with_login", "I don't have a browser profile with your login."),
    ("hyphen_based_login", "I don't have a browser-based login for that site."),
    ("preference", "I don't have a browser preference; any of them works for me."),
    ("any_bookmarks", "I don't have any browser bookmarks of yours."),
    (
        "screenshot_yet",
        "I don't have a browser screenshot of that page yet; let me take one.",
    ),
    ("history", "I don't have any browser history for that site."),
    ("window", "I don't have a browser window for that."),
    ("open_on_mac", "I don't have a browser open on your Mac."),
    ("running", "I don't have a browser running on the Dell."),
    ("favorite", "I don't have a favorite browser."),
    ("preferred", "I don't have a preferred browser."),
    ("default", "I do not have a default browser in mind."),
]


@pytest.mark.parametrize(
    "label,reply", BROWSER_MODIFIER_HONEST, ids=[c[0] for c in BROWSER_MODIFIER_HONEST]
)
def test_t6_c3_browser_as_a_modifier_or_a_state_is_left_alone(label, reply):
    assert guards.capability_claim_check(reply, ALL_TOOLS) is None, (
        f"{label!r}: {reply!r} was wrongly corrected — the guard would be the liar"
    )


# The head-noun shapes the ruling keeps firing: a coordinated "or" list, or
# wording about the capability itself after "browser". VERIFY 2 ruling dropped
# "a browser and terminal here" and "a browser (like Chrome) to use": "and
# <noun>" and a bare parenthetical are off the allowlist (missed lies, logged
# as Survivors, so "a browser and an editor open side by side" stays honest).
BROWSER_HEAD_DENIALS = [
    ("or_ide", "I don't have a browser or IDE."),
    ("of_my_own", "I don't have a browser of my own."),
    ("built_in", "I don't have a browser built in."),
    ("embedded_in", "I don't have a browser embedded in my architecture."),
    ("access", "I don't have any browser access."),
    ("tool", "I don't have a browser tool."),
    ("capability", "I do not have a browser capability."),
]


@pytest.mark.parametrize(
    "label,reply", BROWSER_HEAD_DENIALS, ids=[c[0] for c in BROWSER_HEAD_DENIALS]
)
def test_t6_c1_browser_as_the_head_noun_still_fires(label, reply):
    correction = guards.capability_claim_check(reply, ALL_TOOLS)
    assert correction is not None and "browser_open" in tgt(correction), label


# T6 VERIFY 2 gap (2026-10-09): what may follow "browser" is an ALLOWLIST
# (orchestrator ruling — precision first): end of clause, ", so/but …", a
# coordinated "or <1-3 words>" (optionally a parenthetical) itself followed by
# one of those, or capability wording ("of my own", "built in", "embedded",
# "integrated", "access", "tool", "capability", "available to me", "I can
# use"). A place, a state or a coordinated noun after it is an honest reply
# about another machine or a scene, never her capability.
BROWSER_PLACE_OR_LIST_HONEST = [
    (
        "installed_on_sandbox_image",
        "I don't have a browser installed on the Dell's sandbox image,"
        " so I'll install Firefox there.",
    ),
    (
        "available_on_desktop_session",
        "I don't have a browser available on the mini PC's desktop session,"
        " so I'll use the headless one.",
    ),
    ("installed_on_your_mac", "I don't have a browser installed on your Mac."),
    ("installed_on_the_dell_yet", "I don't have a browser installed on the Dell yet."),
    ("available_on_that_machine", "I don't have a browser available on that machine."),
    ("any_installed_in_container", "I don't have any browser installed in the sandbox container."),
    ("available_offline", "I don't have a browser available offline."),
    (
        "and_editor_side_by_side",
        "I don't have a browser and an editor open side by side like you do.",
    ),
    ("and_terminal_side_by_side", "I don't have a browser and a terminal side by side."),
]


@pytest.mark.parametrize(
    "label,reply", BROWSER_PLACE_OR_LIST_HONEST, ids=[c[0] for c in BROWSER_PLACE_OR_LIST_HONEST]
)
def test_t6_c3_browser_in_a_place_or_a_list_is_left_alone(label, reply):
    assert guards.capability_claim_check(reply, ALL_TOOLS) is None, (
        f"{label!r}: {reply!r} was wrongly corrected — the guard would be the liar"
    )


# ", so I can't …" after the denied browser is the denial's consequence, not a
# qualifier: these are lies while browser_open is registered.
BROWSER_SO_I_CANT_DENIALS = [
    ("bare_so_i_cant", "I don't have a browser, so I can't look."),
    ("built_in_so_i_cant", "I don't have a built-in browser, so I can't check the page."),
]


@pytest.mark.parametrize(
    "label,reply", BROWSER_SO_I_CANT_DENIALS, ids=[c[0] for c in BROWSER_SO_I_CANT_DENIALS]
)
def test_t6_c1_a_denial_followed_by_so_i_cant_still_fires(label, reply):
    correction = guards.capability_claim_check(reply, ALL_TOOLS)
    assert correction is not None and "browser_open" in tgt(correction), label


# -- S29b T1 (2026-10-09): her web search ------------------------------------
#
# Live 10-09 (dell:qwen3:8b), with web_search registered: "I can't search the
# web" and "I don't have web search" -> capability_claim_check returned None.
# _CAPABILITY_TOOLS had no web_search row (browsing is fetch_url's row, and
# "search" is not "browse"), and _DENIAL_LEAD reads "don't have" only as
# "don't have the ability/access to", so the possession form reached nothing.
#
# Criteria (RED 2026-10-09):
#   C1 a first-person, present LEAD-form denial of the general ability to
#      search the web ("search the web/internet/online", "do/run/perform web
#      searches", "look things up online") draws a correction naming
#      web_search while web_search is in the live tool list; the live
#      "I can't search the web" is one of them.
#   C2 a first-person, present POSSESSION denial ("I don't/do not have" + web
#      search / a (web) search tool / internet search) draws the same
#      correction; the live "I don't have web search" is one of them.
#   C3 derived: the SAME sentences are silent for web_search when it is not in
#      the tool list, and fire on a tool list of web_search alone.
#   C4 precision: another subject, a past form, a hedge, one failed search, a
#      stated present state ("right now because the search engine isn't
#      answering"), a qualified limit ("websites that require your login"), a
#      different object ("your email"), and "web search" as a MODIFIER
#      ("web search results/history") are silent — each pinned as a PAIR
#      against a sentence that fires.
#   C5 the correction over itself is clean (self-reference).

WEB_SEARCH_LEAD_DENIALS = [
    ("live_1009_cant_search_the_web", "I can't search the web."),
    ("no_cant_search_the_web", "No, I can't search the web."),
    ("cannot_search_the_internet", "I cannot search the internet."),
    ("unable_to_search_online", "I'm unable to search online."),
    ("not_able_to_perform_web_searches", "I am not able to perform web searches."),
    ("cant_do_web_searches", "I can't do web searches."),
    ("cant_run_a_web_search", "I can't run a web search for you."),
    ("cant_look_things_up_online", "I can't look things up online."),
    ("no_access_to_web_search", "I don't have access to web search."),
    ("capabilities_dont_include", "My capabilities don't include searching the web."),
]

WEB_SEARCH_POSSESSION_DENIALS = [
    ("live_1009_dont_have_web_search", "I don't have web search."),
    ("dont_have_web_search_so", "I don't have web search, so I can't check that."),
    ("do_not_have_a_search_tool", "I do not have a search tool."),
    ("dont_have_a_web_search_tool", "I don't have a web search tool."),
    ("dont_have_web_search_capabilities", "I don't have web search capabilities."),
    ("dont_have_internet_search", "I don't have internet search."),
    ("curly_apostrophe", "I don’t have web search."),
]

WEB_SEARCH_DENIALS = WEB_SEARCH_LEAD_DENIALS + WEB_SEARCH_POSSESSION_DENIALS


@pytest.mark.parametrize(
    "label,reply", WEB_SEARCH_LEAD_DENIALS, ids=[c[0] for c in WEB_SEARCH_LEAD_DENIALS]
)
def test_s29b_t1_c1_a_lead_denial_of_web_search_is_corrected(label, reply):
    correction = guards.capability_claim_check(reply, ALL_TOOLS)
    assert correction is not None, f"{label!r}: a false denial of web_search went uncorrected"
    assert "web_search" in tgt(correction), (label, tgt(correction))
    assert "web_search" in correction.text


@pytest.mark.parametrize(
    "label,reply", WEB_SEARCH_POSSESSION_DENIALS, ids=[c[0] for c in WEB_SEARCH_POSSESSION_DENIALS]
)
def test_s29b_t1_c2_a_possession_denial_of_web_search_is_corrected(label, reply):
    correction = guards.capability_claim_check(reply, ALL_TOOLS)
    assert correction is not None, f"{label!r}: a false denial of web_search went uncorrected"
    assert "web_search" in tgt(correction), (label, tgt(correction))


@pytest.mark.parametrize("label,reply", WEB_SEARCH_DENIALS, ids=[c[0] for c in WEB_SEARCH_DENIALS])
def test_s29b_t1_c3_the_web_search_denial_flips_on_the_live_tool_list(label, reply):
    alone = guards.capability_claim_check(reply, ["web_search"])
    assert alone is not None and tgt(alone) == ["web_search"], label
    without = [t for t in ALL_TOOLS if t != "web_search"]
    correction = guards.capability_claim_check(reply, without)
    assert correction is None or "web_search" not in tgt(correction), label
    assert guards.capability_claim_check(reply, []) is None, label


# (label, a sentence that fires, its minimal honest edit)
WEB_SEARCH_PAIRS = [
    # another subject
    (
        "other_subject_you",
        "I can't search the web.",
        "You can't search the web from the lock screen.",
    ),
    ("other_subject_machine", "I can't search the web.", "The Dell can't search the web."),
    ("other_subject_possession", "I don't have web search.", "You don't have web search enabled."),
    # past
    (
        "past_couldnt",
        "I can't search the web.",
        "I couldn't search the web earlier — the engine timed out.",
    ),
    (
        "past_possession",
        "I don't have web search.",
        "I didn't have web search in the last version.",
    ),
    # hedged
    ("hedge_might", "I can't search the web.", "I might not be able to search the web from here."),
    (
        "hedge_possession",
        "I don't have web search.",
        "I might not have web search on this machine.",
    ),
    # one failed search
    (
        "one_search_came_back_empty",
        "I can't search the web.",
        "I can't find any results because the web search came back empty.",
    ),
    (
        "one_search_result_unclear",
        "I can't search the web.",
        "I can't tell from the web search results whether it shipped.",
    ),
    # a stated present state
    (
        "present_state_lead",
        "I can't search the web.",
        "I can't search the web right now because the search engine isn't answering.",
    ),
    (
        "present_state_possession",
        "I don't have web search.",
        "I don't have web search right now because the search engine isn't answering.",
    ),
    (
        "search_engine_not_answering",
        "I can't search the web.",
        "The search engine isn't answering right now.",
    ),
    # a qualified limit
    (
        "qualified_login",
        "I can't search the web.",
        "I can't search websites that require your login.",
    ),
    (
        "qualified_behind_login",
        "I can't search the web.",
        "I can't search web pages behind your login.",
    ),
    # a different object
    ("different_object_email", "I can't search the web.", "I can't search your email."),
    (
        "different_object_tool_for",
        "I don't have a web search tool.",
        "I don't have a search tool for your email.",
    ),
    # "web search" as a modifier, not the thing she lacks
    (
        "modifier_results",
        "I don't have web search.",
        "I don't have web search results for that yet.",
    ),
    ("modifier_history", "I don't have web search.", "I don't have any web search history."),
    (
        "the_search_results_you_mean",
        "I don't have web search.",
        "I don't have the search results you mean.",
    ),
]


@pytest.mark.parametrize(
    "label,fires,honest", WEB_SEARCH_PAIRS, ids=[c[0] for c in WEB_SEARCH_PAIRS]
)
def test_s29b_t1_c4_an_honest_edit_of_a_web_search_denial_is_left_alone(label, fires, honest):
    correction = guards.capability_claim_check(fires, ALL_TOOLS)
    assert correction is not None and "web_search" in tgt(correction), (
        f"{label!r}: the first-person form {fires!r} must fire for the pair to mean anything"
    )
    assert guards.capability_claim_check(honest, ALL_TOOLS) is None, (
        f"{label!r}: {honest!r} was wrongly corrected — the guard would be the liar"
    )


def test_s29b_t1_c5_the_web_search_correction_is_clean_over_itself():
    for _label, reply in WEB_SEARCH_DENIALS:
        correction = guards.capability_claim_check(reply, ALL_TOOLS)
        assert correction is not None and "web_search" in tgt(correction), reply
        assert guards.capability_claim_check(correction.text, ALL_TOOLS) is None, reply


# COVERAGE (2026-10-09): shapes GREEN's rows read that the RED lists did not
# pin — the trailing form through the lead row's gerund, and the honest
# neighbours of the "access to" lookbehind, of the qualified tail, and of the
# possession row's present-state lookahead (reached only past a capability
# word, since the allowlist already stops a bare "… right now").
WEB_SEARCH_COVERAGE_PAIRS = [
    (
        "trailing_form_vs_access_to_results",
        "Searching the web isn't something I can do.",
        "I don't have access to web search results for that.",
    ),
    (
        "flat_vs_from_your_phone",
        "I can't search the internet.",
        "I can't search the internet from your phone.",
    ),
    (
        "capability_word_vs_present_state",
        "I don't have web search access.",
        "I don't have web search access right now because the engine is down.",
    ),
]


@pytest.mark.parametrize(
    "label,fires,honest",
    WEB_SEARCH_COVERAGE_PAIRS,
    ids=[c[0] for c in WEB_SEARCH_COVERAGE_PAIRS],
)
def test_s29b_t1_coverage_the_rows_other_shapes(label, fires, honest):
    correction = guards.capability_claim_check(fires, ALL_TOOLS)
    assert correction is not None and tgt(correction) == ["web_search"], (label, fires)
    assert guards.capability_claim_check(honest, ALL_TOOLS) is None, (label, honest)


# -- S29b T1 fix (VERIFY 1, 2026-10-09): what FOLLOWS the phrase is an allowlist
#
# VERIFY corrected five honest replies: the lead row carried S38's qualified
# tail (a DENYlist), so "… for your private Slack messages", "… about your bank
# account", "… for files on your laptop" fired; the possession row borrowed the
# browser's capability words, so "… of my own; I use searxng" and "web search
# access to your intranet" fired. Orchestrator ruling (the browser possession
# row's shape, local-context T6): the denial fires only when what follows the
# phrase is (1) the end of the clause, (2) ", so/but …", (3) "for you" then 1-2,
# (4) "or <1-3 words>" then 1-3, (5) "access"/"tool"/"capability" then 1-2 —
# plus (6) the trailing denial itself ("Searching the web isn't something I can
# do"), which the trailing form already fired on and is no less a lie. Anything
# else (an object, a place, a time or a state) is silent: precision first.

WEB_SEARCH_ALLOWLIST_HONEST = [
    # VERIFY's five
    ("verify_slack_object", "I can't search the web for your private Slack messages."),
    (
        "verify_about_bank_account",
        "I can't look things up online about your bank account, that needs your login.",
    ),
    (
        "verify_files_on_laptop",
        "I can't search the internet for files on your laptop; try device_list_files.",
    ),
    (
        "verify_engine_of_my_own",
        "I don't have an internet search engine of my own; I use searxng through web_search.",
    ),
    ("verify_access_to_intranet", "I don't have web search access to your intranet."),
    # more of the same kinds: object, place, time, state
    ("object_for_your_taxes", "I can't look things up online for your taxes."),
    ("place_this_network", "I can't search the web on this network."),
    ("place_inside_vpn", "I can't search online from inside your VPN."),
    ("time_today", "I can't search the web today."),
    ("state_offline", "I can't search the web offline."),
    ("possession_state_chat_mode", "I don't have web search access in this chat mode."),
    (
        "possession_built_in",
        "I don't have a web search engine built in; I go through searxng.",
    ),
]

WEB_SEARCH_ALLOWLIST_DENIALS = [
    # (6) the trailing denial, now with the bare noun as its subject
    ("verify_survivor_trailing_bare", "Web search isn't something I can do."),
    ("trailing_bare_plural", "Internet searches aren't something I can do."),
    ("trailing_gerund_for_you", "Searching the web isn't something I can do for you."),
    # (4) a coordinated alternative after the possession object
    ("possession_or_browser", "I don't have web search or a browser."),
    ("lead_or_words_for_you", "I can't search the web or browse websites for you."),
    # (3) for you, (5) capability wording then ", but"
    ("lead_for_you", "I can't search the web for you."),
    ("possession_tools_but", "I don't have web search tools, but I can read a page you send."),
]

WEB_SEARCH_ALLOWLIST_STILL_SILENT = [
    # the bare noun only reads as a trailing denial's subject
    ("bare_noun_after_lead", "I can't say web search."),
    ("bare_noun_not_working", "I can't confirm web search isn't working."),
]


@pytest.mark.parametrize(
    "label,reply",
    WEB_SEARCH_ALLOWLIST_HONEST + WEB_SEARCH_ALLOWLIST_STILL_SILENT,
    ids=[c[0] for c in WEB_SEARCH_ALLOWLIST_HONEST + WEB_SEARCH_ALLOWLIST_STILL_SILENT],
)
def test_s29b_t1_fix_a_tail_off_the_allowlist_is_silent(label, reply):
    assert guards.capability_claim_check(reply, ALL_TOOLS) is None, (
        f"{label!r}: {reply!r} was wrongly corrected — the guard would be the liar"
    )


@pytest.mark.parametrize(
    "label,reply",
    WEB_SEARCH_ALLOWLIST_DENIALS,
    ids=[c[0] for c in WEB_SEARCH_ALLOWLIST_DENIALS],
)
def test_s29b_t1_fix_a_tail_on_the_allowlist_still_fires(label, reply):
    correction = guards.capability_claim_check(reply, ALL_TOOLS)
    assert correction is not None and "web_search" in tgt(correction), (label, reply)
    alone = guards.capability_claim_check(reply, ["web_search"])
    assert alone is not None and tgt(alone) == ["web_search"], label
    assert guards.capability_claim_check(reply, []) is None, label
    assert guards.capability_claim_check(correction.text, ALL_TOOLS) is None, label


# -- S29b T2 (2026-10-09): her device tools, as GENERAL abilities -------------
#
# Live 10-09 (dell:qwen3:8b), with device_run registered: "No, I can't run
# commands on your laptop" -> capability_claim_check returned None. The S42a
# device_run row reads only Windows/Mac nouns, and no row maps a phrase to
# device_read_file / device_list_files / device_write_file / device_launch_app /
# device_notify.
#
# Criteria (RED 2026-10-09):
#   C1 a first-person, present denial of a device tool's GENERAL ability on a
#      GENERAL noun ("your laptop/computer/PC/machine(s)/devices", "a
#      computer") draws a correction naming that device tool while it is in
#      the live tool list: run commands/programs -> device_run, read/list/
#      write files -> device_read_file/device_list_files/device_write_file,
#      open apps -> device_launch_app, send notifications -> device_notify.
#      The live "No, I can't run commands on your laptop" is one of them.
#   C2 what FOLLOWS the device noun is an ALLOWLIST from the start (T1's and
#      the browser row's lesson): the end of the clause, ", so/but …", "for
#      you", "or <1-3 words>", capability wording. Anything else is silent.
#   C3 derived: the same sentences name no device tool once that tool is out
#      of the live list, and are silent on [].
#   C4 precision: a NAMED device, offline/asleep/unreachable/right now, an
#      object or a limit ("that need sudo", "with sudo", "that need admin
#      rights"), past, hedged, another subject, an instruction to him, quoted
#      user text and one thing ("the command") name no device tool.
#   C5 the correction over itself is clean.
#
# Assumptions (design calls):
#   * the silent cases assert no device_* tool is named, not None: the
#     workspace rows already fire on "read/write/list files on your machine
#     that …" (measured 10-09: "I can't read files on your machine that need
#     sudo" -> workspace_read_file). That is a pre-existing workspace-row
#     behaviour outside T2 (Notes, known gap).
#   * phone is SILENT, not firing: device_notify is "a desktop notification
#     on a paired device" and novad has no phone build, so "I can't send
#     notifications to your phone" is true today. The firing notify case
#     names a computer instead.
#   * a closing quote is not the end of a clause: 'You said "I can't run
#     commands on your laptop".' is his text, and the allowlist's end must
#     not admit ["”'’] before [.!?].
#   * a colon is the end of a clause for the browser/web rows; here
#     "…on your laptop: it isn't reachable" is a stated state, so the device
#     rows must not read ':' as an allowed end (or must read what follows it).

DEVICE_TOOLS = frozenset(t for t in ALL_TOOLS if t.startswith("device_"))

DEVICE_DENIALS = [
    (
        "live_1009_no_cant_run_commands_laptop",
        "No, I can't run commands on your laptop",
        "device_run",
    ),
    ("cant_run_programs_computer", "I can't run programs on your computer.", "device_run"),
    (
        "not_able_read_files_machine",
        "I'm not able to read files on your machine.",
        "device_read_file",
    ),
    ("cant_open_apps_pc", "I can't open apps on your PC.", "device_launch_app"),
    (
        "cant_send_notifications_computer",
        "I can't send notifications to your computer.",
        "device_notify",
    ),
    ("cant_list_files_computer", "I can't list files on your computer.", "device_list_files"),
    ("cannot_write_files_machine", "I cannot write files on your machine.", "device_write_file"),
    ("unable_run_commands_machines", "I'm unable to run commands on your machines.", "device_run"),
    ("cant_run_commands_a_computer", "I can't run commands on a computer.", "device_run"),
    # C2's allowlist: ", so/but …", "for you", "or <1-3 words>"
    (
        "so_tail",
        "I can't run commands on your laptop, so you'll have to run it.",
        "device_run",
    ),
    ("but_tail", "I can't run programs on your computer, but I can explain them.", "device_run"),
    ("for_you_tail", "I can't run commands on your devices for you.", "device_run"),
    ("or_words_tail", "I can't open apps on your computer or tablet.", "device_launch_app"),
]


@pytest.mark.parametrize("label,reply,tool", DEVICE_DENIALS, ids=[c[0] for c in DEVICE_DENIALS])
def test_s29b_t2_c1_a_general_device_denial_is_corrected(label, reply, tool):
    correction = guards.capability_claim_check(reply, ALL_TOOLS)
    assert correction is not None, f"{label!r}: a false denial of {tool} went uncorrected"
    assert tool in tgt(correction), (label, tgt(correction))
    assert tool in correction.text


@pytest.mark.parametrize("label,reply,tool", DEVICE_DENIALS, ids=[c[0] for c in DEVICE_DENIALS])
def test_s29b_t2_c3_the_device_denial_flips_on_the_live_tool_list(label, reply, tool):
    alone = guards.capability_claim_check(reply, [tool])
    assert alone is not None and tgt(alone) == [tool], label
    without = [t for t in ALL_TOOLS if t != tool]
    correction = guards.capability_claim_check(reply, without)
    assert correction is None or tool not in tgt(correction), label
    assert guards.capability_claim_check(reply, []) is None, label


def test_s29b_t2_c5_the_device_correction_is_clean_over_itself():
    for _label, reply, tool in DEVICE_DENIALS:
        correction = guards.capability_claim_check(reply, ALL_TOOLS)
        assert correction is not None and tool in tgt(correction), reply
        assert guards.capability_claim_check(correction.text, ALL_TOOLS) is None, reply


DEVICE_HONEST = [
    # a NAMED device: one machine's state, not the ability
    ("named_dell_offline", "I can't run commands on the Dell right now, it's offline."),
    ("named_minipc_asleep", "I can't run commands on minipc, it's asleep."),
    ("named_mac_until_paired", "I can't list files on the Mac until it's paired."),
    # offline / asleep / unreachable / right now
    ("asleep_right_now", "I can't run commands on your laptop right now because it's asleep."),
    ("while_offline", "I can't run commands on your laptop while it's offline."),
    ("colon_unreachable", "I can't run commands on your laptop: it isn't reachable."),
    ("dash_offline", "I can't run programs on your computer — it's offline."),
    # an object or a limit
    ("object_need_sudo", "I can't read files on your machine that need sudo."),
    ("limit_with_sudo", "I can't run commands on your laptop with sudo."),
    ("limit_as_administrator", "I can't run programs on your computer as administrator."),
    ("object_admin_apps", "I can't open apps on your PC that need admin rights."),
    ("limit_outside_home", "I can't read files on your computer outside your home folder."),
    ("phone_no_agent", "I can't send notifications to your phone."),
    # past
    ("past_couldnt_the_command", "I couldn't run the command on your laptop."),
    ("past_couldnt_earlier", "I couldn't run commands on your laptop earlier."),
    # hedged
    ("hedged_might", "I might not be able to run commands on your laptop."),
    # another subject
    ("other_subject_you", "You can't run commands on your laptop from the lock screen."),
    ("other_subject_nova_third", "Nova can't run commands on your laptop until you pair it."),
    # an instruction to him
    ("instruction_to_him", "Run commands on your laptop from the terminal."),
    # quoted user text
    ("quoted_user_text", 'You said "I can\'t run commands on your laptop".'),
    ("quoted_in_ticket", 'You wrote "I can\'t run commands on your laptop" in the ticket.'),
    # one thing, not the ability
    ("one_command", "I can't run the command on your laptop."),
]


@pytest.mark.parametrize("label,reply", DEVICE_HONEST, ids=[c[0] for c in DEVICE_HONEST])
def test_s29b_t2_c4_an_honest_device_sentence_names_no_device_tool(label, reply):
    correction = guards.capability_claim_check(reply, ALL_TOOLS)
    named = set(tgt(correction)) & DEVICE_TOOLS if correction is not None else set()
    assert not named, f"{label!r}: {reply!r} was wrongly corrected for {sorted(named)}"


# (label, a sentence that fires, its minimal honest edit) — each honest edit
# is pinned against a sentence that fires, so the pair means something.
DEVICE_PAIRS = [
    (
        "named_vs_general",
        "I can't run commands on your laptop.",
        "I can't run commands on the Dell, it's offline.",
    ),
    (
        "present_state",
        "I can't run commands on your laptop.",
        "I can't run commands on your laptop right now.",
    ),
    (
        "object_tail",
        "I can't read files on your computer.",
        "I can't read files on your computer that are encrypted.",
    ),
    ("past", "I can't open apps on your PC.", "I couldn't open apps on your PC."),
    (
        "hedged",
        "I can't run programs on your computer.",
        "I may not be able to run programs on your computer.",
    ),
    (
        "other_subject",
        "I can't list files on your machine.",
        "You can't list files on your machine.",
    ),
]


@pytest.mark.parametrize("label,fires,honest", DEVICE_PAIRS, ids=[c[0] for c in DEVICE_PAIRS])
def test_s29b_t2_c4_an_honest_edit_of_a_device_denial_names_no_device_tool(label, fires, honest):
    correction = guards.capability_claim_check(fires, ALL_TOOLS)
    assert correction is not None and set(tgt(correction)) & DEVICE_TOOLS, (
        f"{label!r}: the first-person form {fires!r} must fire for the pair to mean anything"
    )
    edit = guards.capability_claim_check(honest, ALL_TOOLS)
    named = set(tgt(edit)) & DEVICE_TOOLS if edit is not None else set()
    assert not named, f"{label!r}: {honest!r} was wrongly corrected for {sorted(named)}"


# -- S29b T2 COVERAGE: the allowlist's edges ----------------------------------
#
# C2's allowlist admits a few capability words after the noun ("directly",
# "myself", "remotely", "at all") and refuses a period INSIDE a closing quote
# and a stated present state after ", so …". Each is pinned here; RED/GREEN
# above pinned only the ", so/but", "for you", "or <words>" arms.

DEVICE_ALLOWLIST_FIRES = [
    ("directly", "I can't run commands on your laptop directly.", "device_run"),
    ("myself", "I'm unable to read files on your computer myself.", "device_read_file"),
    ("at_all", "I can't open apps on your PC at all.", "device_launch_app"),
    ("remotely", "I cannot list files on your machine remotely.", "device_list_files"),
]


@pytest.mark.parametrize(
    "label,reply,tool", DEVICE_ALLOWLIST_FIRES, ids=[c[0] for c in DEVICE_ALLOWLIST_FIRES]
)
def test_s29b_t2_c2_capability_words_after_the_noun_still_fire(label, reply, tool):
    correction = guards.capability_claim_check(reply, [tool])
    assert correction is not None and tgt(correction) == [tool], label


DEVICE_ALLOWLIST_SILENT = [
    ("period_inside_quote", 'You said "I can\'t run commands on your laptop."'),
    (
        "so_then_present_state",
        "I can't run commands on your laptop, so I can't check it right now.",
    ),
    ("unlisted_word", "I can't list files on your PC today."),
    ("and_another_place", "I can't write files to your computer and the NAS."),
    # "the" names ONE machine, never the ability (design: general nouns only)
    ("the_one_laptop", "I can't run commands on the laptop."),
]


@pytest.mark.parametrize(
    "label,reply", DEVICE_ALLOWLIST_SILENT, ids=[c[0] for c in DEVICE_ALLOWLIST_SILENT]
)
def test_s29b_t2_c2_a_tail_outside_the_allowlist_names_no_device_tool(label, reply):
    correction = guards.capability_claim_check(reply, ALL_TOOLS)
    named = set(tgt(correction)) & DEVICE_TOOLS if correction is not None else set()
    assert not named, f"{label!r}: {reply!r} was wrongly corrected for {sorted(named)}"


# -- S29b T2 fix (2026-10-09): a denial hedged in its own clause --------------
#
# T2 VERIFY: "Maybe I can't run commands on your laptop; let me check whether
# it's paired." was corrected for device_run, and the same hedge was already
# corrected on every row on main ("Maybe I can't browse the web." -> fetch_url).
# Orchestrator ruling: fix it ONCE in the shared lead (_DENIAL_LEAD) — a
# "maybe / perhaps / possibly / probably" directly before the first-person
# denial is a hedge, not an assertion, so the clause is silent. "I think I
# can't …" and "Honestly, I can't …" are assertions and still fire.

HEDGED_DENIALS = [
    (
        "verify_device_run_check_paired",
        "Maybe I can't run commands on your laptop; let me check whether it's paired.",
    ),
    ("verify_device_run_perhaps", "Perhaps I can't run commands on your laptop."),
    ("verify_device_run_maybe", "Maybe I can't run commands on your laptop."),
    ("cross_row_browse", "Maybe I can't browse the web."),
    ("web_search_maybe", "Maybe I can't search the web; let me try."),
    ("web_search_possibly", "Possibly I can't search the web."),
    ("windows_maybe", "Maybe I can't run commands on a Windows machine; let me check."),
    ("device_read_file_probably", "Probably I can't read files on your computer."),
    ("device_list_files_perhaps_mid", "I'll try, but perhaps I can't list files on your PC."),
    ("device_launch_app_maybe_unable", "Maybe I'm unable to open apps on your computer."),
]


@pytest.mark.parametrize("label,reply", HEDGED_DENIALS, ids=[c[0] for c in HEDGED_DENIALS])
def test_s29b_t2_fix_a_hedged_denial_is_silent(label, reply):
    assert guards.capability_claim_check(reply, ALL_TOOLS) is None, label


HEDGE_FIRING_CONTROLS = [
    ("i_think", "I think I can't run commands on your laptop.", "device_run"),
    ("honestly", "Honestly, I can't search the web.", "web_search"),
    ("plain_after_hedged_clause", "Maybe not; I can't run commands on your laptop.", "device_run"),
]


@pytest.mark.parametrize(
    "label,reply,tool", HEDGE_FIRING_CONTROLS, ids=[c[0] for c in HEDGE_FIRING_CONTROLS]
)
def test_s29b_t2_fix_an_unhedged_assertion_still_fires(label, reply, tool):
    correction = guards.capability_claim_check(reply, [tool])
    assert correction is not None and tgt(correction) == [tool], label
