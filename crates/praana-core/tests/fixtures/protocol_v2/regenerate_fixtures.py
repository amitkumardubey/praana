#!/usr/bin/env python3
"""One-off normative protocol-v2 fixture migration.

This script deliberately does not call ConversationProjection::project. It only
normalizes hand-authored event/message payloads to the protocol owner DTOs.
"""

from __future__ import annotations

import json
import hashlib
from pathlib import Path
from typing import Any


ROOT = Path(__file__).parent
ZERO = "0" * 64
ENDPOINT = "a" * 64
MODEL = {
    "provider": "openai",
    "protocol": "openai-responses-v1",
    "model": "gpt-5",
    "model_revision": "2026-08-01",
    "model_family": "gpt-5",
    "endpoint_fingerprint": ENDPOINT,
    "reasoning_effort": "medium",
}


def compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def canonical_hash(value: Any) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def usage(input_tokens: int = 0, output_tokens: int = 0) -> dict[str, int]:
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "reasoning_tokens": 0,
        "total_tokens": input_tokens + output_tokens,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
    }


def order_usage(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "input_tokens": value["input_tokens"],
        "output_tokens": value["output_tokens"],
        "reasoning_tokens": value["reasoning_tokens"],
        "total_tokens": value["total_tokens"],
        "cache_read_tokens": value["cache_read_tokens"],
        "cache_write_tokens": value["cache_write_tokens"],
    }


def order_json_map(value: dict[str, Any]) -> dict[str, Any]:
    return {
        key: (
            order_json_map(item)
            if isinstance(item, dict)
            else [order_json_map(v) if isinstance(v, dict) else v for v in item]
            if isinstance(item, list)
            else item
        )
        for key, item in sorted(value.items())
    }


def order_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = []
    for block in blocks:
        block_type = block["type"]
        data = block["data"]
        if block_type == "text":
            data = {"text": data["text"]}
        elif block_type == "reasoning_summary":
            data = {
                "text": data["text"],
                "provider_item_id": data.get("provider_item_id"),
            }
        elif block_type == "refusal":
            data = {
                "text": data["text"],
                "provider_item_id": data.get("provider_item_id"),
            }
        elif block_type == "tool_call":
            data = {
                "call_id": data.get("call_id"),
                "name": data["name"],
                "arguments": order_json_map(data["arguments"])
                if isinstance(data.get("arguments"), dict)
                else data.get("arguments"),
                "raw_arguments": data["raw_arguments"],
            }
        ordered.append({"type": block_type, "data": data})
    return ordered


def order_tool_result(message: dict[str, Any]) -> dict[str, Any]:
    body = message["body"]
    content = body["content"]
    if content["storage"] == "inline":
        content_data = {"text": content["data"]["text"]}
    else:
        reference = content["data"]["reference"]
        retrieval = reference["retrieval"]
        content_data = {
            "preview": content["data"]["preview"],
            "reference": {
                "artifact_id": reference["artifact_id"],
                "sha256": reference["sha256"],
                "media_type": reference["media_type"],
                "byte_count": reference["byte_count"],
                "line_count": reference.get("line_count"),
                "estimated_tokens": reference["estimated_tokens"],
                "token_estimator_schema_version": reference[
                    "token_estimator_schema_version"
                ],
                "estimator_id": reference["estimator_id"],
                "token_input_sha256": reference["token_input_sha256"],
                "retrieval": {
                    "tool": retrieval["tool"],
                    "arguments": order_json_map(retrieval["arguments"]),
                },
            },
        }
    return {
        "message_id": message["message_id"],
        "turn_id": message["turn_id"],
        "step_id": message["step_id"],
        "batch_id": message["batch_id"],
        "execution_id": message["execution_id"],
        "call_id": message["call_id"],
        "tool_name": message["tool_name"],
        "status": message["status"],
        "body": {
            "media_type": body["media_type"],
            "content": {"storage": content["storage"], "data": content_data},
            "sha256": body["sha256"],
            "byte_count": body["byte_count"],
            "line_count": body.get("line_count"),
            "estimated_tokens": body["estimated_tokens"],
            "token_estimator_schema_version": body[
                "token_estimator_schema_version"
            ],
            "estimator_id": body["estimator_id"],
            "token_input_sha256": body["token_input_sha256"],
            "redacted": body["redacted"],
        },
        "recovered": message["recovered"],
    }


def empty_evidence() -> dict[str, list[Any]]:
    return {
        "event_ids": [],
        "artifact_ids": [],
        "state_ids": [],
        "summary_segment_ids": [],
    }


def normalize_handoff(handoff: dict[str, Any]) -> dict[str, Any]:
    content = handoff.setdefault("content", {})
    for key in (
        "current_goals",
        "completed_milestones",
        "active_decisions",
        "active_constraints",
        "files_in_play",
        "test_status",
        "unresolved_errors",
        "open_questions",
        "failed_approaches_to_avoid",
        "next_actions",
        "omissions",
    ):
        content.setdefault(key, [])
    handoff.setdefault("artifact_ids", [])
    handoff.setdefault("state_ids", [])
    handoff.setdefault("estimated_tokens", 0)
    handoff.setdefault("estimator_id", "praana-generic-unicode-15.1-v1")
    handoff.setdefault("rendered_input_sha256", ZERO)
    for key in (
        "current_goals",
        "completed_milestones",
        "active_constraints",
        "unresolved_errors",
        "open_questions",
        "failed_approaches_to_avoid",
        "next_actions",
    ):
        content[key] = [
            {
                "text": statement["text"],
                "confidence": statement["confidence"],
                "evidence": {
                    "event_ids": statement["evidence"].get("event_ids", []),
                    "artifact_ids": statement["evidence"].get("artifact_ids", []),
                    "state_ids": statement["evidence"].get("state_ids", []),
                    "summary_segment_ids": statement["evidence"].get(
                        "summary_segment_ids", []
                    ),
                },
                "uncertainty": statement.get("uncertainty"),
            }
            for statement in content[key]
        ]
    content = {
        "current_goals": content["current_goals"],
        "completed_milestones": content["completed_milestones"],
        "active_decisions": content["active_decisions"],
        "active_constraints": content["active_constraints"],
        "files_in_play": content["files_in_play"],
        "test_status": content["test_status"],
        "unresolved_errors": content["unresolved_errors"],
        "open_questions": content["open_questions"],
        "failed_approaches_to_avoid": content["failed_approaches_to_avoid"],
        "next_actions": content["next_actions"],
        "omissions": content["omissions"],
    }
    ordered = {
        "handoff_schema_version": handoff["handoff_schema_version"],
        "handoff_id": handoff["handoff_id"],
        "reason": handoff["reason"],
        "label": handoff["label"],
        "epoch": handoff["epoch"],
        "lineage_through_epoch": handoff["lineage_through_epoch"],
        "source_start_sequence": handoff["source_start_sequence"],
        "source_end_sequence": handoff["source_end_sequence"],
        "based_on_previous_handoff": handoff.get("based_on_previous_handoff"),
        "content": content,
        "artifact_ids": handoff["artifact_ids"],
        "state_ids": handoff["state_ids"],
        "estimated_tokens": handoff["estimated_tokens"],
        "estimator_id": handoff["estimator_id"],
        "rendered_input_sha256": handoff["rendered_input_sha256"],
    }
    handoff.clear()
    handoff.update(ordered)
    return handoff


def normalize_continuation(message: dict[str, Any]) -> None:
    old = message.get("continuation")
    if old is None or old.get("provider_protocol") == "open_ai_responses":
        return
    old_data = old.get("data", {})
    output_items = []
    for block in message.get("blocks", []):
        block_type = block.get("type")
        data = block.get("data", {})
        if block_type == "reasoning_summary":
            output_items.append(
                {
                    "type": "reasoning",
                    "data": {
                        "id": data.get("provider_item_id"),
                        "status": "completed",
                        "summary": [{"text": data.get("text", "")}],
                        "encrypted_content": old_data.get("bytes_b64"),
                    },
                }
            )
        elif block_type == "tool_call" and data.get("call_id"):
            output_items.append(
                {
                    "type": "function_call",
                    "data": {
                        "id": None,
                        "status": "completed",
                        "call_id": data["call_id"],
                        "name": data.get("name", "unknown_tool"),
                        "arguments": data.get("raw_arguments", "{}"),
                    },
                }
            )
        elif block_type == "text":
            output_items.append(
                {
                    "type": "message",
                    "data": {
                        "id": None,
                        "status": "completed",
                        "role": "assistant",
                        "phase": message.get("phase"),
                        "content": [
                            {
                                "type": "output_text",
                                "data": {"text": data.get("text", ""), "annotations": []},
                            }
                        ],
                    },
                }
            )
    message["continuation"] = {
        "provider_protocol": "open_ai_responses",
        "data": {
            "scope": {
                "provider": message.get("provider", "openai"),
                "protocol": "openai-responses-v1",
                "model": message.get("model", "gpt-5"),
                "model_revision": "2026-08-01",
                "endpoint_fingerprint": ENDPOINT,
            },
            "response_id": old_data.get("previous_response_id"),
            "output_items": output_items,
        },
    }


def normalize_message(message: dict[str, Any]) -> None:
    for block in message.get("blocks", []):
        if block.get("type") == "thought":
            data = block.get("data", {})
            block["type"] = "reasoning_summary"
            block["data"] = {
                "text": data.get("text", ""),
                "provider_item_id": data.get("provider_item_id"),
            }
    message["blocks"] = order_blocks(message.get("blocks", []))
    message["usage"] = order_usage(message["usage"])
    normalize_continuation(message)


def state_source(envelope: dict[str, Any]) -> dict[str, Any]:
    return {
        "source_kind": "system",
        "event_id": envelope["event_id"],
        "sequence": envelope["sequence"],
        "turn_id": envelope.get("turn_id"),
        "attempt_id": envelope.get("attempt_id"),
        "tool_call_id": None,
        "artifact_id": None,
        "summary_segment_id": None,
    }


def optional_patch(value: Any) -> dict[str, Any]:
    if isinstance(value, dict) and "action" in value:
        return value
    if value is None:
        return {"action": "keep"}
    return {"action": "set", "value": value}


def normalize_state_changed(envelope: dict[str, Any], data: dict[str, Any]) -> None:
    source = {
        "source_kind": "system",
        "event_id": "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        "sequence": 1,
        "turn_id": None,
        "attempt_id": None,
        "tool_call_id": None,
        "artifact_id": None,
        "summary_segment_id": None,
    }
    data["reason"] = {
        "explicit_user_action": "explicit_tool",
        "explicit_tool": "explicit_tool",
    }.get(data.get("reason"), "system")
    data["source"] = source
    for op in data.get("operations", []):
        kind = op.get("op")
        if kind == "create":
            value = op.get("value", {})
            if value.get("kind") == "task":
                task = value.get("value", {})
                op["value"] = {
                    "kind": "task",
                    "value": {
                        "title": task.get("title", ""),
                        "description": task.get("description"),
                        "status": {
                            "pending": "todo",
                            "doing": "in_progress",
                            "completed": "done",
                        }.get(task.get("status"), task.get("status", "todo")),
                        "blocker": task.get("blocker"),
                    },
                }
        elif kind == "update_task":
            patch = op.get("patch", {})
            op["patch"] = {
                "title": patch.get("title"),
                "description": optional_patch(patch.get("description")),
                "status": {
                    "pending": "todo",
                    "doing": "in_progress",
                    "completed": "done",
                }.get(patch.get("status"), patch.get("status")),
                "blocker": optional_patch(patch.get("blocker")),
            }
        elif kind == "set_focus":
            patch = op.get("patch", {})
            if isinstance(patch, dict) and "action" not in patch:
                focus = patch.get("focus")
                op["patch"] = (
                    {"action": "set", "value": focus}
                    if focus
                    else {"action": "clear"}
                )


def normalize_compaction(envelope: dict[str, Any], old: dict[str, Any]) -> dict[str, Any]:
    handoff = normalize_handoff(old["handoff"])
    source_turn_ids = old.get("source_turn_ids", old.get("compacted_turn_ids", []))
    compaction_id = old.get("compaction_id", envelope["event_id"])
    segment_id = handoff["handoff_id"]
    source_hash = old.get("source_hash", ZERO)
    source_start = old.get("source_start_sequence", 1)
    source_end = old.get("source_end_sequence", source_start)
    epoch = old.get("epoch", 1)
    return {
        "compaction_schema_version": old.get("compaction_schema_version", 1),
        "compaction_id": compaction_id,
        "policy_version": "rust-v2-compaction-1",
        "epoch": epoch,
        "reset_epoch": old.get("reset_epoch", 0),
        "source_start_sequence": source_start,
        "source_end_sequence": source_end,
        "source_hash": source_hash,
        "source_turn_ids": source_turn_ids,
        "eligible_source_tokens": old.get("eligible_source_tokens", 100),
        "target_source_tokens": old.get("target_source_tokens", 100),
        "retired_source_tokens": old.get("retired_source_tokens", 100),
        "segment": {
            "summary_segment_schema_version": 1,
            "segment_id": segment_id,
            "epoch": epoch,
            "source": {
                "reset_epoch": old.get("reset_epoch", 0),
                "start_sequence": source_start,
                "end_sequence": source_end,
                "turn_ids": source_turn_ids,
                "event_prefix_hash_before": ZERO,
                "source_hash": source_hash,
                "source_tokens": old.get("eligible_source_tokens", 100),
                "source_estimator_id": "praana-generic-unicode-15.1-v1",
                "source_input_sha256": source_hash,
            },
            "content": {
                "user_goals": [],
                "scope_changes": [],
                "completed_work": [],
                "files_and_symbols_changed": [],
                "decisions": [],
                "constraints": [],
                "commands_and_tests": [],
                "failed_approaches": [],
                "unresolved_errors": [],
                "unresolved_questions": [],
                "contradictions": [],
                "omissions": [],
            },
            "artifact_ids": [],
            "state_ids": old.get("retained_state_ids", []),
        },
        "segment_hash": ZERO,
        "handoff": handoff,
        "handoff_hash": ZERO,
        "candidate_hash": ZERO,
        "output_tokens": handoff.get("estimated_tokens", 0),
        "strategy": {
            "type": "same_model_internal",
            "data": {
                "provider": "openai",
                "model": "gpt-5",
                "capability_profile_version": "1",
            },
        },
        "provider": "openai",
        "protocol": "openai-responses-v1",
        "model": "gpt-5",
        "model_revision": "2026-08-01",
        "prompt_version": "rust-v2-compaction-prompt-1",
        "token_estimator_schema_version": 1,
        "estimator_id": "praana-generic-unicode-15.1-v1",
        "output_input_sha256": ZERO,
        "artifact_ids": [],
        "state_ids": old.get("retained_state_ids", []),
        "attempt_started_event_id": envelope["event_id"],
    }


def normalize_event(
    fixture: str,
    envelope: dict[str, Any],
    attempts: dict[str, dict[str, Any]],
    accepted_events: dict[str, str],
    current_model: dict[str, Any],
    step_aliases: dict[str, str],
) -> None:
    event = envelope.get("event", {})
    kind = event.get("kind")
    data = event.get("data", {})
    attempt_id = envelope.get("attempt_id")

    if kind == "assistant_attempt_started" and attempt_id:
        retry_of = data.get("retry_of")
        if retry_of in attempts:
            previous_purpose = attempts[retry_of]["purpose"]
            if (
                previous_purpose.get("type") == "assistant_step"
                and data.get("purpose", {}).get("type") == "assistant_step"
            ):
                old_step = data["purpose"]["data"]["step_id"]
                canonical_step = previous_purpose["data"]["step_id"]
                step_aliases[old_step] = canonical_step
                data["purpose"] = previous_purpose
        attempts[attempt_id] = data
    elif kind == "assistant_step_accepted":
        started = attempts.get(attempt_id)
        if started and started["purpose"]["type"] == "assistant_step":
            data["purpose"] = started["purpose"]["data"]
            data["message"]["step_id"] = data["purpose"]["step_id"]
        normalize_message(data["message"])
        if fixture == "e14_tool_call_id_reused" and envelope["sequence"] == 10:
            data["message"]["finish_reason"] = "tool_use"
        if fixture == "e15_tool_arguments_scalar":
            data["message"]["finish_reason"] = "tool_use"
            for block in data["message"]["blocks"]:
                if block["type"] == "tool_call":
                    block["data"]["arguments"] = {}
        if attempt_id:
            accepted_events[attempt_id] = envelope["event_id"]
    elif kind == "assistant_attempt_failed":
        if {
            "purpose",
            "error",
            "partial_output",
            "observable_delta_emitted",
            "provider_may_have_completed",
            "usage",
        }.issubset(data):
            if fixture in {
                "08_partial_emission_then_interruption",
                "e31_retry_after_emission",
            }:
                data["partial_output"]["blocks"] = [
                    {
                        "type": "text",
                        "data": {"text": "partial provider output"},
                    }
                ]
                data["observable_delta_emitted"] = True
            return
        started = attempts.get(attempt_id, {})
        partial_tokens = data.get("partial_output_tokens", 0)
        partial_blocks = (
            [{"type": "text", "data": {"text": "partial provider output"}}]
            if partial_tokens
            else []
        )
        event["data"] = {
            "purpose": started.get(
                "purpose",
                {
                    "type": "assistant_step",
                    "data": {
                        "step_id": "01ARZ3NDEKTSV4RRFFQ69G5FB3",
                        "step_index": 0,
                    },
                },
            ),
            "error": {
                "code": data.get("error_code", "E_PROVIDER_STREAM"),
                "class": "transport",
                "message": data.get("error_message", data.get("reason", "provider failed")),
                "retryable": bool(data.get("retryable", False)),
                "http_status": None,
                "retry_after_ms": None,
            },
            "partial_output": {
                "blocks": partial_blocks,
                "provider_response_id": None,
            },
            "observable_delta_emitted": bool(partial_tokens),
            "provider_may_have_completed": False,
            "usage": usage(),
        }
    elif kind == "assistant_attempt_superseded":
        replacement = data.get("superseded_by_attempt_id")
        old_attempt = data["superseded_attempt_id"]
        event["kind"] = "attempt_superseded"
        event["data"] = {
            "purpose": attempts.get(old_attempt, {}).get(
                "purpose",
                {
                    "type": "assistant_step",
                    "data": {
                        "step_id": "01ARZ3NDEKTSV4RRFFQ69G5FB3",
                        "step_index": 0,
                    },
                },
            ),
            "superseded_attempt_id": old_attempt,
            "replacement_attempt_id": replacement,
            "replacement_accept_event_id": accepted_events.get(
                replacement, envelope["event_id"]
            ),
            "reason": "retry",
        }
        envelope["attempt_id"] = None
    elif kind == "turn_interrupted":
        old_reason = data.get("reason", "provider_failure")
        event["data"] = {
            "turn_index": data["turn_index"],
            "user_message_id": data["user_message_id"],
            "reason": {
                "provider_failed_after_emission": "provider_failure",
                "provider_failure": "provider_failure",
                "user_abort": "user_abort",
            }.get(old_reason, "provider_failure"),
            "last_accepted_step_id": (
                data.get("accepted_step_ids") or [None]
            )[-1],
            "failed_attempt_id": attempt_id
            or next(reversed(attempts), None),
            "uncertain_execution_ids": [],
            "message": "Turn interrupted before commit.",
        }
    elif kind == "history_compacted":
        event["data"] = normalize_compaction(envelope, data)
        envelope["attempt_id"] = envelope.get("attempt_id") or envelope["event_id"]
    elif kind == "model_changed":
        target = data.get("to", data.get("target_model", MODEL))
        event["data"] = {
            "from": dict(current_model),
            "to": target,
            "reason": (
                "provider_fallback"
                if fixture == "21_provider_fallback_initial_attempt"
                else "user_selection"
            ),
            "continuation_disposition": {
                "retained_compatible": "retained",
                "retained": "retained",
                "dropped_incompatible": "dropped_incompatible",
                "none": "none",
            }.get(
                data.get(
                    "continuation_disposition", data.get("disposition", "none")
                ),
                "none",
            ),
            "handoff": normalize_handoff(data["handoff"]),
            "toolset_hash": data.get("toolset_hash", data.get("target_toolset_hash", "b" * 64)),
        }
        current_model.clear()
        current_model.update(target)
    elif kind == "reset_boundary":
        previous_turn = envelope.get("turn_id")
        event["data"] = {
            "reset_epoch": data["reset_epoch"],
            "command": "/clear",
            "reason": data.get("reason"),
            "clears_state": True,
            "previous_turn_id": previous_turn,
        }
        envelope["turn_id"] = None
    elif kind == "state_changed":
        normalize_state_changed(envelope, data)
        if fixture == "17_state_rebuild_and_focus":
            for operation in data["operations"]:
                if operation["op"] == "set_focus":
                    operation["patch"] = {
                        "action": "set",
                        "value": "01ARZ3NDEKTSV4RRFFQ69G5FS2",
                    }
    elif kind == "tool_execution_finished":
        data["result"] = order_tool_result(data["result"])
        content = data["result"]["body"]["content"]
        if content.get("storage") == "artifact" and "reference" not in content.get("data", {}):
            body = data["result"]["body"]
            artifact_id = content["data"]["artifact_id"]
            content["data"] = {
                "preview": f"Artifact {artifact_id}: tool result unavailable in this fixture.",
                "reference": {
                    "artifact_id": artifact_id,
                    "sha256": body["sha256"],
                    "media_type": body["media_type"],
                    "byte_count": body["byte_count"],
                    "line_count": body["line_count"],
                    "estimated_tokens": body["estimated_tokens"],
                    "token_estimator_schema_version": body[
                        "token_estimator_schema_version"
                    ],
                    "estimator_id": body["estimator_id"],
                    "token_input_sha256": body["token_input_sha256"],
                    "retrieval": {
                        "tool": "retrieve_artifact",
                        "arguments": {"artifact_id": artifact_id},
                    },
                },
            }
    elif kind == "turn_committed":
        data["terminal_step_id"] = step_aliases.get(
            data["terminal_step_id"], data["terminal_step_id"]
        )
        data["accepted_step_ids"] = [
            step_aliases.get(step_id, step_id)
            for step_id in data["accepted_step_ids"]
        ]


def normalize_projection(value: dict[str, Any]) -> None:
    for message in value.get("messages", []):
        data = message.get("data", {})
        if message.get("role") == "assistant":
            normalize_message(data)
        elif message.get("role") == "tool_result":
            pass
    handoff = value.get("active_handoff")
    if handoff is not None:
        normalize_handoff(handoff)

    state = value.get("current_state", {})
    for obj in state.get("objects", []):
        obj["lifecycle"] = {
            "active": "current",
            "current": "current",
            "retracted": "retracted",
        }.get(obj.get("lifecycle"), obj.get("lifecycle", "current"))
        obj["source"] = {
            "source_kind": "system",
            "event_id": "01ARZ3NDEKTSV4RRFFQ69G5FAW",
            "sequence": 1,
            "turn_id": None,
            "attempt_id": None,
            "tool_call_id": None,
            "artifact_id": None,
            "summary_segment_id": None,
        }
        value_data = obj.get("value", {})
        if value_data.get("kind") == "task":
            task = value_data.get("value", {})
            obj["value"] = {
                "kind": "task",
                "value": {
                    "title": task.get("title", ""),
                    "description": task.get("description"),
                    "status": {
                        "pending": "todo",
                        "doing": "in_progress",
                        "completed": "done",
                    }.get(task.get("status"), task.get("status", "todo")),
                    "blocker": task.get("blocker"),
                },
            }
        ordered_obj = {
            "state_id": obj["state_id"],
            "revision": obj["revision"],
            "tier": obj["tier"],
            "lifecycle": obj["lifecycle"],
            "value": obj["value"],
            "created_at_ms": obj["created_at_ms"],
            "created_sequence": obj["created_sequence"],
            "updated_at_ms": obj["updated_at_ms"],
            "updated_sequence": obj["updated_sequence"],
            "last_touched_at_ms": obj["last_touched_at_ms"],
            "last_touched_sequence": obj["last_touched_sequence"],
            "last_touched_turn_ordinal": obj["last_touched_turn_ordinal"],
            "source": obj["source"],
            "retracted_reason": obj.get("retracted_reason"),
        }
        obj.clear()
        obj.update(ordered_obj)
    focus = state.get("focus")
    if focus is not None:
        focus = {
            "state_id": focus["state_id"],
            "set_at_ms": focus["set_at_ms"],
            "set_sequence": focus["set_sequence"],
        }
    ordered_messages = []
    for tagged in value.get("messages", []):
        data = tagged["data"]
        role = tagged["role"]
        if role == "user":
            data = {
                "message_id": data["message_id"],
                "turn_id": data["turn_id"],
                "blocks": order_blocks(data.get("blocks", [])),
            }
        elif role == "assistant":
            data = {
                "message_id": data["message_id"],
                "turn_id": data["turn_id"],
                "step_id": data["step_id"],
                "provider": data["provider"],
                "model": data["model"],
                "phase": data.get("phase"),
                "blocks": data.get("blocks", []),
                "finish_reason": data["finish_reason"],
                "continuation": data.get("continuation"),
                "usage": data["usage"],
            }
        elif role == "tool_result":
            data = order_tool_result(data)
        ordered_messages.append({"role": role, "data": data})

    ordered_state = {
        "schema_version": state.get("schema_version", 1),
        "reset_epoch": state.get("reset_epoch", value.get("reset_epoch", 0)),
        "applied_through_sequence": state.get(
            "applied_through_sequence", value.get("through_sequence", 0)
        ),
        "committed_turn_ordinal": state.get("committed_turn_ordinal", 0),
        "focus": focus,
        "objects": state.get("objects", []),
    }
    active_continuation = value.get("active_continuation")
    if (
        active_continuation is not None
        and active_continuation.get("provider_protocol") != "open_ai_responses"
    ):
        active_continuation = next(
            (
                tagged["data"].get("continuation")
                for tagged in reversed(ordered_messages)
                if tagged["role"] == "assistant"
                and tagged["data"].get("continuation") is not None
            ),
            None,
        )
    pending_recovery = [
        {
            "notice_id": notice["notice_id"],
            "kind": notice["kind"],
            "source_event_ids": notice.get("source_event_ids", []),
            "message": notice["message"],
            "required_action": notice["required_action"],
        }
        for notice in value.get("pending_recovery", [])
    ]
    ordered = {
        "reset_epoch": value.get("reset_epoch", 0),
        "through_sequence": value.get("through_sequence", 0),
        "active_handoff": value.get("active_handoff"),
        "messages": ordered_messages,
        "current_state": ordered_state,
        "active_turn": (
            value["active_turn"].get("turn_id")
            if isinstance(value.get("active_turn"), dict)
            else value.get("active_turn")
        ),
        "pending_recovery": pending_recovery,
        "active_continuation": active_continuation,
        "compacted_turn_ids": value.get("compacted_turn_ids", []),
    }
    value.clear()
    value.update(ordered)


def rewrite_fixture(directory: Path) -> None:
    fixture = directory.name
    path = directory / "events.jsonl"
    original = path.read_bytes()
    had_final_lf = original.endswith(b"\n")
    lines = original.splitlines()
    has_compaction_starts = False
    filtered_lines = []
    for raw in lines:
        try:
            item = json.loads(raw)
        except json.JSONDecodeError:
            filtered_lines.append(raw)
            continue
        is_compaction_start = (
            item.get("event", {}).get("kind") == "assistant_attempt_started"
            and item["event"]["data"].get("purpose", {}).get("type") == "compaction"
        )
        if is_compaction_start:
            has_compaction_starts = True
        else:
            filtered_lines.append(raw)
    if has_compaction_starts:
        lines = filtered_lines
        resequenced = []
        for sequence, raw in enumerate(lines, 1):
            item = json.loads(raw)
            item["sequence"] = sequence
            resequenced.append(compact(item).encode())
        lines = resequenced
    output: list[bytes] = []
    attempts: dict[str, dict[str, Any]] = {}
    accepted_events: dict[str, str] = {}
    current_model = dict(MODEL)
    step_aliases: dict[str, str] = {}
    parsed_existing = []
    for raw in lines:
        try:
            parsed_existing.append(json.loads(raw))
        except json.JSONDecodeError:
            continue
    compaction_start_ids = {
        item["event_id"]
        for item in parsed_existing
        if item.get("event", {}).get("kind") == "assistant_attempt_started"
        and item["event"]["data"].get("purpose", {}).get("type") == "compaction"
    }
    used_event_ids = {item.get("event_id") for item in parsed_existing}
    inserted = 0

    preserve_raw = {
        ("e04_duplicate_json_key", 2),
        ("e09_nonfinal_malformed", 2),
        ("19_truncated_final_line", len(lines)),
    }
    for line_number, raw in enumerate(lines, 1):
        if (fixture, line_number) in preserve_raw:
            output.append(raw)
            continue
        try:
            envelope = json.loads(raw)
        except json.JSONDecodeError:
            output.append(raw)
            continue
        envelope["sequence"] += inserted
        normalize_event(
            fixture,
            envelope,
            attempts,
            accepted_events,
            current_model,
            step_aliases,
        )
        if envelope["event"]["kind"] == "history_compacted":
            compaction = envelope["event"]["data"]
            if compaction["attempt_started_event_id"] not in compaction_start_ids:
                suffix = 0
                while True:
                    start_event_id = f"01ARZ3NDEKTSV4RRFFQ69G5FZ{suffix:X}"
                    if start_event_id not in used_event_ids:
                        break
                    suffix += 1
                attempt_id = f"01ARZ3NDEKTSV4RRFFQ69G5FY{suffix:X}"
                used_event_ids.add(start_event_id)
                start = {
                    "schema_version": 2,
                    "event_id": start_event_id,
                    "session_id": envelope["session_id"],
                    "sequence": envelope["sequence"],
                    "timestamp_ms": envelope["timestamp_ms"] - 1,
                    "turn_id": None,
                    "attempt_id": attempt_id,
                    "event": {
                        "kind": "assistant_attempt_started",
                        "data": {
                            "purpose": {
                                "type": "compaction",
                                "data": {
                                    "compaction_id": compaction["compaction_id"],
                                    "epoch": compaction["epoch"],
                                },
                            },
                            "attempt_number": 1,
                            "model": dict(MODEL),
                            "request_hash": "c" * 64,
                            "admission": {
                                "token_estimator_schema_version": 1,
                                "estimator_id": "provider-tokenizer:openai:o200k_base:1",
                                "estimated_input_sha256": "9" * 64,
                                "context_window_tokens": 200000,
                                "estimated_input_tokens": 1200,
                                "resolved_output_tokens": 4096,
                                "requested_reasoning_tokens": 4096,
                                "safety_margin_tokens": 1000,
                                "projected_fill_millionths": 51960,
                                "capability_profile_hash": "e" * 64,
                                "estimate_reused_from_attempt_id": None,
                            },
                            "retry_of": None,
                            "emergency_context_retry": False,
                            "recovery_notices": [],
                        },
                    },
                }
                output.append(compact(start).encode())
                compaction["attempt_started_event_id"] = start_event_id
                envelope["attempt_id"] = attempt_id
                envelope["sequence"] += 1
                inserted += 1
        output.append(compact(envelope).encode())

    objects: list[dict[str, Any] | None] = []
    for raw in output:
        try:
            objects.append(json.loads(raw))
        except json.JSONDecodeError:
            objects.append(None)
    users: dict[str, dict[str, Any]] = {}
    assistants: dict[str, dict[str, Any]] = {}
    finishes: dict[str, dict[str, Any]] = {}
    batches: dict[str, dict[str, Any]] = {}
    for item in objects:
        if item is None:
            continue
        event = item["event"]
        data = event["data"]
        kind = event["kind"]
        turn_id = item.get("turn_id")
        if kind == "user_message_accepted":
            users[turn_id] = {"role": "user", "data": data["message"]}
        elif kind == "assistant_step_accepted":
            assistants[data["purpose"]["step_id"]] = {
                "role": "assistant",
                "data": data["message"],
            }
        elif kind == "tool_execution_finished":
            finishes[item["event_id"]] = data["result"]
        elif kind == "tool_batch_completed":
            if any(event_id not in finishes for event_id in data["result_event_ids"]):
                continue
            results = [finishes[event_id] for event_id in data["result_event_ids"]]
            data["result_messages_hash"] = canonical_hash(results)
            batches[data["step_id"]] = {
                "data": data,
                "results": [
                    {"role": "tool_result", "data": result} for result in results
                ],
            }
        elif kind == "turn_committed":
            if turn_id not in users or any(
                step_id not in assistants for step_id in data["accepted_step_ids"]
            ):
                continue
            accepted = [users[turn_id]]
            for step_id in data["accepted_step_ids"]:
                accepted.append(assistants[step_id])
                if step_id in batches:
                    accepted.extend(batches[step_id]["results"])
            data["accepted_messages_hash"] = canonical_hash(accepted)

    serialized = [compact(item).encode() if item is not None else raw for item, raw in zip(objects, output)]
    for item in objects:
        if item is None or item["event"]["kind"] != "history_compacted":
            continue
        data = item["event"]["data"]
        if fixture != "e26_compaction_hash_mismatch":
            selected = serialized[
                data["source_start_sequence"] - 1 : data["source_end_sequence"]
            ]
            source_hash = hashlib.sha256(
                b"".join(line + b"\n" for line in selected)
            ).hexdigest()
            data["source_hash"] = source_hash
            data["segment"]["source"]["source_hash"] = source_hash
            data["segment"]["source"]["source_input_sha256"] = source_hash
        data["segment_hash"] = canonical_hash(data["segment"])
        data["handoff_hash"] = canonical_hash(data["handoff"])
    output = [compact(item).encode() if item is not None else raw for item, raw in zip(objects, output)]

    terminator = b"\n" if had_final_lf and fixture != "19_truncated_final_line" else b""
    path.write_bytes(b"\n".join(output) + terminator)

    projection_path = directory / "expected_projection.json"
    if projection_path.exists():
        projection = json.loads(projection_path.read_text())
        normalize_projection(projection)
        if fixture == "12_orphan_artifact_recovery":
            projection["messages"] = [
                tagged
                for tagged in projection["messages"]
                if tagged["role"] == "user"
            ]
        accepted_step_by_message = {
            item["event"]["data"]["message"]["message_id"]: item["event"]["data"][
                "purpose"
            ]["step_id"]
            for item in objects
            if item is not None
            and item["event"]["kind"] == "assistant_step_accepted"
        }
        for tagged in projection["messages"]:
            if tagged["role"] == "assistant":
                message_id = tagged["data"]["message_id"]
                tagged["data"]["step_id"] = accepted_step_by_message.get(
                    message_id, tagged["data"]["step_id"]
                )
        if inserted:
            last_sequence = max(
                item["sequence"] for item in objects if item is not None
            )
            projection["through_sequence"] = last_sequence
            projection["current_state"]["applied_through_sequence"] = last_sequence
        projection_path.write_text(compact(projection) + "\n")

    if fixture in {
        "12_orphan_artifact_recovery",
        "e22_missing_artifact",
        "e23_artifact_hash_mismatch",
    }:
        manifest_path = directory / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["phase"] = "p3"
        manifest_path.write_text(compact(manifest) + "\n")

    error_path = directory / "expected_error.json"
    if error_path.exists():
        error = json.loads(error_path.read_text())
        if inserted and error.get("sequence") is not None:
            compacted = next(
                item
                for item in objects
                if item is not None and item["event"]["kind"] == "history_compacted"
            )
            error["sequence"] = compacted["sequence"]
            error["line"] = compacted["sequence"]
        ordered_error = {
            "code": error["code"],
            "sequence": error.get("sequence"),
            "line": error["line"],
            "recoverable": False,
        }
        error_path.write_text(compact(ordered_error) + "\n")


def main() -> None:
    for directory in sorted(ROOT.iterdir()):
        if directory.is_dir() and (directory / "events.jsonl").exists():
            rewrite_fixture(directory)


if __name__ == "__main__":
    main()
