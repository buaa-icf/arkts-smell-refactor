import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from arkts_smell_refactor.agent_runtime import DEFAULT_AGENT_MODEL, DISABLED_AGENT_TOOLS, agent_environment, run_agent
from arkts_smell_refactor.cli import build_parser, main as cli_main
from arkts_smell_refactor.gate import main as gate_main


class AgentRuntimeTests(unittest.TestCase):
    def test_coding_plan_variant_mapping_preserves_provider_and_other_options(self):
        for variant in ("low", "high", "max"):
            with self.subTest(variant=variant):
                config = {"provider": {"zhipu-coding": {
                    "options": {"apiKey": "test-secret", "baseURL": "https://example.invalid/coding"},
                    "models": {"glm-5": {"options": {"otherOption": 12}, "variants": {
                        variant: {"reasoningEffort": "stale", "reasoning_effort": "stale", "disabled": True, "temperature": 1},
                        "another-preset": {"maxTokens": 2048},
                    }}},
                }}}
                original = {"DEVECO_CONFIG_CONTENT": json.dumps(config)}
                env = agent_environment(original, model=DEFAULT_AGENT_MODEL, variant=variant)
                merged = json.loads(env["DEVECO_CONFIG_CONTENT"])["provider"]["zhipu-coding"]
                self.assertEqual(config["provider"]["zhipu-coding"]["options"], merged["options"])
                model = merged["models"]["glm-5"]
                self.assertEqual({"otherOption": 12}, model["options"])
                self.assertEqual({"temperature": 1, "reasoningEffort": variant}, model["variants"][variant])
                self.assertEqual({"maxTokens": 2048}, model["variants"]["another-preset"])
                self.assertEqual(config, json.loads(original["DEVECO_CONFIG_CONTENT"]))

    def test_refactor_effort_does_not_leak_into_default_review(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"DEVECO_CONFIG_CONTENT": ""}), patch(
            "arkts_smell_refactor.agent_runtime.subprocess.run"
        ) as run:
            root = Path(temp)
            run_agent(Path("deveco"), root, root, root / "prompt.md", role="refactor", variant="high")
            refactor_config = json.loads(run.call_args.kwargs["env"]["DEVECO_CONFIG_CONTENT"])
            self.assertEqual({"reasoningEffort": "high"}, refactor_config["provider"]["zhipu-coding"]["models"]["glm-5"]["variants"]["high"])
            self.assertEqual("high", json.loads((root / "refactor-execution-policy.json").read_text(encoding="utf-8"))["requestedReasoningEffort"])
            run_agent(Path("deveco"), root, root, root / "prompt.md", role="review")
            self.assertNotIn("--variant", run.call_args.args[0])
            self.assertNotIn("provider", json.loads(run.call_args.kwargs["env"]["DEVECO_CONFIG_CONTENT"]))
            self.assertIsNone(json.loads((root / "review-execution-policy.json").read_text(encoding="utf-8"))["requestedReasoningEffort"])
            self.assertEqual("", os.environ["DEVECO_CONFIG_CONTENT"])

    def test_invalid_coding_plan_variant_cannot_silently_fall_back_to_max(self):
        with tempfile.TemporaryDirectory() as temp, patch(
            "arkts_smell_refactor.agent_runtime.subprocess.run"
        ) as run:
            root = Path(temp)
            for variant in ("hihg", "default", "medium"):
                with self.subTest(variant=variant), self.assertRaisesRegex(ValueError, "low/high/max"):
                    run_agent(Path("deveco"), root, root, root / "prompt.md", role="refactor", variant=variant)
            run.assert_not_called()

    def test_invalid_provider_overlay_is_not_silently_replaced(self):
        for provider in ([], {"zhipu-coding": {"models": []}}, {"zhipu-coding": {"models": {"glm-5": {"variants": {"high": "invalid"}}}}}):
            with self.subTest(provider=provider), self.assertRaises(ValueError):
                agent_environment({"DEVECO_CONFIG_CONTENT": json.dumps({"provider": provider})}, variant="high")

    @unittest.skipUnless(shutil.which("git"), "git unavailable")
    def test_mirror_does_not_discover_parent_repository(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            subprocess.run(["git", "init", "--quiet", str(root)], check=True)
            mirror = root / "runs/task/refactor-workspace"
            mirror.mkdir(parents=True)
            args = ["git", "rev-parse", "--show-toplevel"]
            self.assertEqual(0, subprocess.run(args, cwd=mirror, capture_output=True).returncode)
            original = {**os.environ, "GIT_DIR": str(root / ".git"), "GIT_WORK_TREE": str(root)}
            env = agent_environment(original, cwd=mirror)
            self.assertNotIn("GIT_DIR", env)
            self.assertNotEqual(0, subprocess.run(args, cwd=mirror, env=env, capture_output=True).returncode)
            self.assertIn("GIT_DIR", original)

    def test_format_only_selects_tool_free_agent(self):
        with tempfile.TemporaryDirectory() as temp, patch(
            "arkts_smell_refactor.agent_runtime.subprocess.run"
        ) as run:
            root = Path(temp)
            run_agent(Path("deveco"), root, root, root / "prompt.md", role="review-format", format_only=True)
            command = run.call_args.args[0]
            self.assertEqual("arkts-review-format", command[command.index("--agent") + 1])
            self.assertEqual(DEFAULT_AGENT_MODEL, command[command.index("-m") + 1])
            config = json.loads(run.call_args.kwargs["env"]["DEVECO_CONFIG_CONTENT"])
            self.assertEqual({"*": False}, config["agent"]["arkts-review-format"]["tools"])
            self.assertEqual({"*": "deny"}, config["agent"]["arkts-review-format"]["permission"])

    def test_policy_preserves_environment_and_unrelated_settings(self):
        original = {
            "PATH": "existing-path",
            "DEVECO_CONFIG_CONTENT": json.dumps({
                "permission": {"bash": "ask", "webfetch": "allow"},
                "tools": {"edit": True},
                "disabled_providers": ["unused-provider"],
                "agent": {"build": {"permission": "allow", "tools": {"webfetch": True}}},
                "provider": {"custom": {"options": {"apiKey": "test-secret"}}},
            }),
        }
        env = agent_environment(original)
        self.assertEqual("existing-path", env["PATH"])
        self.assertEqual("1", env["DEVECO_DISABLE_EXTERNAL_SKILLS"])
        self.assertNotIn("DEVECO_DISABLE_DEFAULT_SKILLS", env)
        self.assertNotIn("DEVECO_DISABLE_EXTERNAL_SKILLS", original)
        self.assertNotEqual(env["DEVECO_CONFIG_CONTENT"], original["DEVECO_CONFIG_CONTENT"])
        config = json.loads(env["DEVECO_CONFIG_CONTENT"])
        self.assertEqual(["unused-provider", "deveco"], config["disabled_providers"])
        self.assertEqual(config, json.loads(agent_environment(env)["DEVECO_CONFIG_CONTENT"]))
        self.assertEqual("ask", config["permission"]["bash"])
        self.assertEqual("test-secret", config["provider"]["custom"]["options"]["apiKey"])
        self.assertTrue(config["tools"]["edit"])
        for settings in (config, config["agent"]["build"]):
            for name in DISABLED_AGENT_TOOLS:
                self.assertEqual("deny", settings["permission"][name])
                self.assertFalse(settings["tools"][name])

    def test_malformed_overlay_fails_instead_of_losing_user_settings(self):
        for raw in ("not json", "[]", '{"permission": []}', '{"disabled_providers": "deveco"}', '{"disabled_providers": [false]}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                agent_environment({"DEVECO_CONFIG_CONTENT": raw})

    def test_default_pins_custom_provider_without_inventing_reasoning_variant(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with patch.dict(os.environ, {"DEVECO_CONFIG_CONTENT": ""}), patch(
                "arkts_smell_refactor.agent_runtime.subprocess.run"
            ) as run:
                run.return_value.returncode = 7
                result = run_agent(Path("deveco"), root, root, root / "prompt.md", role="refactor")
            self.assertEqual(7, result)
            command = run.call_args.args[0]
            self.assertNotIn("--variant", command)
            self.assertEqual(DEFAULT_AGENT_MODEL, command[command.index("-m") + 1])
            self.assertNotIn("--thinking", command)
            policy = json.loads((root / "refactor-execution-policy.json").read_text(encoding="utf-8"))
            self.assertEqual(DEFAULT_AGENT_MODEL, policy["requestedModel"])
            self.assertIn("deveco", policy["disabledProviders"])
            self.assertIsNone(policy["requestedVariant"])

    def test_builtin_provider_is_rejected_before_starting_any_agent(self):
        for role in ("refactor", "review", "review-format"):
            with self.subTest(role=role), tempfile.TemporaryDirectory() as temp, patch(
                "arkts_smell_refactor.agent_runtime.subprocess.run"
            ) as run:
                root = Path(temp)
                with self.assertRaisesRegex(ValueError, "zhipu-coding/glm-5"):
                    run_agent(Path("deveco"), root, root, root / "prompt.md", role=role,
                              model="deveco/GLM-5.3", variant="high", format_only=role == "review-format")
                run.assert_not_called()
                self.assertFalse((root / f"{role}-execution-policy.json").exists())

    def test_start_rejects_stale_builtin_environment_before_reading_task(self):
        for role in ("REFACTOR", "REVIEW"):
            with self.subTest(role=role), patch.dict(os.environ, {f"ARKTS_{role}_MODEL": "deveco/GLM-5.3"}, clear=True), patch(
                "arkts_smell_refactor.automatic.read_pasted_json"
            ) as read_input, patch("builtins.print") as output:
                self.assertEqual(2, cli_main(["start", "--workspace", str(Path.cwd())]))
                read_input.assert_not_called()
                self.assertIn("zhipu-coding/glm-5", output.call_args.args[0])

    def test_review_uses_policy_and_separate_requested_model(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "review-prompt.md").write_text("只读评审，输出 JSON。", encoding="utf-8")
            for name, data in {
                "refactor-changes.json": {"changedProductionFiles": []},
                "review-risk.json": {"risks": []},
                "review-context.json": {"productionDependencies": []},
                "gates.json": {"attempt": 0, "gates": []},
            }.items():
                (root / name).write_text(json.dumps(data), encoding="utf-8")
            (root / "review-diff.patch").write_text("", encoding="utf-8")
            with patch.dict(os.environ, {"DEVECO_CONFIG_CONTENT": '{"provider":{"secret":"do-not-log"}}'}), patch(
                "arkts_smell_refactor.agent_runtime.subprocess.run"
            ) as run:
                run.return_value.returncode = 0
                result = gate_main([
                    "review", "--task-dir", temp, "--prompt-file", str(root / "review-prompt.md"),
                    "--deveco", "deveco", "--model", "provider/reviewer", "--variant", "high",
                ])
            self.assertEqual(0, result)
            command = run.call_args.args[0]
            self.assertIn("provider/reviewer", command)
            self.assertEqual("high", command[command.index("--variant") + 1])
            self.assertIn("只读评审", " ".join(command))
            self.assertNotIn("-f", command)
            self.assertEqual((root / "review-agent-prompt.md").read_text(encoding="utf-8"), run.call_args.kwargs["input"])
            self.assertEqual("utf-8", run.call_args.kwargs["encoding"])
            self.assertNotIn("zhipu-coding", json.loads(run.call_args.kwargs["env"]["DEVECO_CONFIG_CONTENT"])["provider"])
            policy = (root / "review-execution-policy.json").read_text(encoding="utf-8")
            self.assertNotIn("do-not-log", policy)
            self.assertFalse(json.loads(policy)["providerSettingsVerified"])
            self.assertTrue(json.loads(policy)["reviewPacketAttached"])
            self.assertEqual("stdin", json.loads(policy)["promptTransport"])

    def test_large_review_packet_goes_through_stdin_without_truncation(self):
        with tempfile.TemporaryDirectory() as temp, patch(
            "arkts_smell_refactor.agent_runtime.subprocess.run"
        ) as run:
            root = Path(temp)
            prompt = root / "review-agent-prompt.md"
            body = "BEGIN\n" + "完整源码：中文\ue001\n" * 8000 + "END\n"
            prompt.write_text(body, encoding="utf-8")
            run.return_value.returncode = 0
            self.assertEqual(0, run_agent(Path("deveco"), root, root, prompt, role="review", prompt_via_stdin=True))
            self.assertEqual(body, run.call_args.kwargs["input"])
            self.assertLess(len(" ".join(run.call_args.args[0])), 1000)
            self.assertNotIn("-f", run.call_args.args[0])

    def test_cli_flags_override_environment_without_changing_review_defaults(self):
        with patch.dict(os.environ, {"ARKTS_REFACTOR_MODEL": "provider/test", "ARKTS_REFACTOR_VARIANT": "high"}, clear=True):
            args = build_parser().parse_args(["start", "--refactor-variant", "low"])
        self.assertEqual("provider/test", args.refactor_model)
        self.assertEqual("low", args.refactor_variant)
        self.assertEqual(DEFAULT_AGENT_MODEL, args.review_model)
        self.assertIsNone(args.review_variant)

    def test_start_defaults_both_roles_to_custom_provider(self):
        with patch.dict(os.environ, {}, clear=True):
            args = build_parser().parse_args(["start"])
        self.assertEqual(DEFAULT_AGENT_MODEL, args.refactor_model)
        self.assertEqual(DEFAULT_AGENT_MODEL, args.review_model)
        self.assertIsNone(args.refactor_variant)
        self.assertIsNone(args.review_variant)
