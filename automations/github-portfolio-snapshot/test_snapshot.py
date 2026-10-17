#!/usr/bin/env python3
"""Deterministic offline tests for snapshot.py.

No network, no Feishu, no gh. Those need credentials a test run must not have,
and a test that needs them is a test nobody runs.

Run: python3 automations/github-portfolio-snapshot/test_snapshot.py
Exit: 0 all pass, 1 any failure.

The work dir is redirected to a temp directory BEFORE importing the module,
because snapshot.py resolves its config at import time.
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))

# --- isolate the module's config before it is imported ----------------------
_WORK = tempfile.mkdtemp(prefix="snapshot-test-home-")
with open(os.path.join(_WORK, "config.json"), "w", encoding="utf-8") as _fh:
    json.dump(
        {
            "github_login": "test-user",
            "base_token": "test-base-token",
            "registry_table": "tblTESTS",
            "activity_buckets": {"active": 30, "cooling": 90, "stale": 180},
        },
        _fh,
    )
os.environ["GITHUB_SNAPSHOT_HOME"] = _WORK

_spec = importlib.util.spec_from_file_location("snapshot", os.path.join(HERE, "snapshot.py"))
snap = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(snap)

TZ = dt.timezone(dt.timedelta(hours=8))


class TestConfigResolution(unittest.TestCase):
    def test_env_var_redirects_the_work_dir(self):
        self.assertEqual(str(snap.WORK_DIR), _WORK)
        self.assertEqual(str(snap.CONFIG_PATH), os.path.join(_WORK, "config.json"))

    def test_config_file_overrides_defaults(self):
        cfg = snap.load_config()
        self.assertEqual(cfg["github_login"], "test-user")
        self.assertEqual(cfg["base_token"], "test-base-token")
        self.assertEqual(cfg["registry_table"], "tblTESTS")

    def test_required_keys_have_no_shipped_default(self):
        # A public repository must not ship a working default for these: it would
        # silently point a new operator at someone else's Base.
        for key in snap.REQUIRED_CONFIG_KEYS:
            self.assertEqual(snap.DEFAULT_CONFIG[key], "", f"{key} must default to empty")

    def test_missing_required_key_names_the_config_path(self):
        empty = tempfile.mkdtemp(prefix="snapshot-test-empty-")
        original = snap.CONFIG_PATH
        try:
            snap.CONFIG_PATH = __import__("pathlib").Path(empty) / "config.json"
            with self.assertRaises(snap.ConfigError) as ctx:
                snap.load_config()
            message = str(ctx.exception)
            self.assertIn("缺少必填配置", message)
            self.assertIn(str(snap.CONFIG_PATH), message, "错误必须指出去哪儿找配置")
        finally:
            snap.CONFIG_PATH = original

    def test_partial_config_still_reports_every_missing_key(self):
        partial = tempfile.mkdtemp(prefix="snapshot-test-partial-")
        path = os.path.join(partial, "config.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"github_login": "x"}, handle)
        original = snap.CONFIG_PATH
        try:
            snap.CONFIG_PATH = __import__("pathlib").Path(path)
            with self.assertRaises(snap.ConfigError) as ctx:
                snap.load_config()
            # base_token and registry_table are both absent — report both, not the first.
            self.assertIn("base_token", str(ctx.exception))
            self.assertIn("registry_table", str(ctx.exception))
        finally:
            snap.CONFIG_PATH = original


class TestScalarNormalization(unittest.TestCase):
    """Regression guard for a silent write failure.

    Snapshot values are scalars on write, but reading the previous period back
    from the Base returns select/multi-select fields as lists. Without _scalar()
    the script wrote [[Archive]], which the Base rejects — and the job exited 1
    with no useful message.
    """

    def test_nested_list_collapses_to_its_first_element(self):
        self.assertEqual(snap._scalar(["Archive"]), "Archive")
        self.assertEqual(snap._scalar([["Archive"]]), ["Archive"])  # one level only
        self.assertEqual(snap._scalar(["Archive", "Keep"]), "Archive")

    def test_empty_and_none(self):
        self.assertEqual(snap._scalar([]), "")
        self.assertEqual(snap._scalar(None), "")

    def test_strings_pass_through(self):
        self.assertEqual(snap._scalar("Active"), "Active")
        self.assertEqual(snap._scalar(42), "42")


class TestAsList(unittest.TestCase):
    def test_none_becomes_empty(self):
        self.assertEqual(snap._as_list(None), [])

    def test_json_string_is_decoded(self):
        self.assertEqual(snap._as_list('["a","b"]'), ["a", "b"])

    def test_non_json_string_is_wrapped(self):
        self.assertEqual(snap._as_list("solo"), ["solo"])

    def test_list_passes_through(self):
        self.assertEqual(snap._as_list(["a"]), ["a"])


class TestDiscoverabilityScore(unittest.TestCase):
    def test_full_marks(self):
        self.assertEqual(
            snap.discoverability_score(
                {"has_description": True, "topics_count": 3,
                 "has_homepage": True, "readme_early_install": False}
            ),
            4,
        )

    def test_zero_when_nothing_is_present(self):
        self.assertEqual(
            snap.discoverability_score(
                {"has_description": False, "topics_count": 0,
                 "has_homepage": False, "readme_early_install": True}
            ),
            0,
        )

    def test_readme_none_neither_scores_nor_penalises(self):
        unknown = snap.discoverability_score(
            {"has_description": True, "topics_count": 0,
             "has_homepage": False, "readme_early_install": None}
        )
        failing = snap.discoverability_score(
            {"has_description": True, "topics_count": 0,
             "has_homepage": False, "readme_early_install": True}
        )
        self.assertEqual(unknown, failing, "None 不应被当成已满足")


class TestDateHelpers(unittest.TestCase):
    def test_iso_with_z(self):
        parsed = snap._parse_dt("2026-10-17T12:00:00Z")
        self.assertEqual(snap._created_key("2026-10-17T12:00:00Z"), "2026-10-17")

    def test_epoch_milliseconds(self):
        parsed = snap._parse_dt(1760712000000)
        self.assertIsNotNone(parsed)
        self.assertIsNotNone(parsed.tzinfo)

    def test_junk_is_none_not_an_exception(self):
        self.assertIsNone(snap._parse_dt("not a date"))
        self.assertIsNone(snap._parse_dt(""))
        self.assertEqual(snap._created_key("not a date"), "")


def _node(**overrides):
    base = {
        "id": 1, "name": "demo", "url": "https://github.com/u/demo",
        "isPrivate": False, "isArchived": False, "isFork": False,
        "description": "a demo repo", "stargazerCount": 3, "forkCount": 1,
        "pushedAt": "2026-10-10T00:00:00Z", "createdAt": "2026-01-01T00:00:00Z",
        "pullRequests": {"totalCount": 2}, "releases": {"totalCount": 1},
        "homepageUrl": "", "repositoryTopics": {"nodes": []},
        "_commits": 5, "_branch": "main", "_readme_early_install": None,
    }
    base.update(overrides)
    return base


class TestNormalizeRepo(unittest.TestCase):
    def setUp(self):
        self.now = dt.datetime(2026, 10, 17, 20, 0, tzinfo=TZ)

    def test_maps_github_fields_to_snapshot_facts(self):
        fact = snap.normalize_repo(_node(), self.now)
        self.assertEqual(fact["repo_name"], "demo")
        self.assertEqual(fact["visibility"], "Public")
        self.assertEqual(fact["commits"], 5)
        self.assertEqual(fact["pull_requests"], 2)
        self.assertEqual(fact["default_branch"], "main")

    def test_activity_buckets_respect_the_config_boundaries(self):
        # CFG here sets active=30 / cooling=90 / stale=180; boundaries are <=.
        for days, expected_key in ((30, "active"), (31, "cooling"), (90, "cooling"),
                                   (91, "stale"), (180, "stale"), (181, "dormant")):
            # Convert to UTC BEFORE formatting: replace("+08:00", "Z") would keep
            # the wall-clock time and shift the instant by 8 hours, which made an
            # earlier version of this test fail on correct code.
            pushed = (
                (self.now - dt.timedelta(days=days))
                .astimezone(dt.timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
            )
            fact = snap.normalize_repo(_node(pushedAt=pushed), self.now)
            self.assertEqual(fact["days_since_push"], days)
            self.assertEqual(fact["activity_state"], snap.ACTIVITY[expected_key],
                             f"{days} days should land in {expected_key}")

    def test_private_and_archived_are_reflected(self):
        fact = snap.normalize_repo(_node(isPrivate=True, isArchived=True), self.now)
        self.assertEqual(fact["visibility"], "Private")
        self.assertTrue(fact["archived"])

    def test_discoverability_inputs_come_from_the_same_node(self):
        fact = snap.normalize_repo(
            _node(homepageUrl=" https://x.dev ",
                  repositoryTopics={"nodes": [{"name": "a"}, {"name": "b"}]},
                  _readme_early_install=False),
            self.now,
        )
        self.assertTrue(fact["has_homepage"], "只有空白字符时应视为没有 homepage")
        self.assertEqual(fact["topics_count"], 2)
        self.assertEqual(fact["readme_early_install"], False)
        self.assertEqual(snap.discoverability_score(fact), 4)


class TestFeishuTransport(unittest.TestCase):
    """直连飞书 OpenAPI 的传输层。

    这层替代了原来的 `lark-cli` 子进程调用，因此必须证明三件事：
    ① 凭据只从环境变量来（不碰 keychain）；
    ② 响应信封被正确剥掉（{code,msg,data} → data）；
    ③ 失败会变成可读的异常，而不是静默返回空。
    全部离线：`_http_json` 被替换成脚本化的假实现。
    """

    def setUp(self):
        snap._TOKEN_CACHE["value"] = ""
        snap._TOKEN_CACHE["expires_at"] = 0.0
        self._saved = {k: os.environ.get(k) for k in ("FEISHU_APP_ID", "FEISHU_APP_SECRET")}
        os.environ["FEISHU_APP_ID"] = "cli_test_app"
        os.environ["FEISHU_APP_SECRET"] = "test_secret"
        self._orig_http = snap._http_json

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        snap._http_json = self._orig_http
        snap._TOKEN_CACHE["value"] = ""
        snap._TOKEN_CACHE["expires_at"] = 0.0

    def _stub(self, responses):
        """按顺序返回预设响应，并记录每次请求。"""
        queue = list(responses)
        calls = []

        def fake(req, what):
            calls.append(what)
            if not queue:
                raise AssertionError(f"出现计划外的请求：{what}")
            return queue.pop(0)

        snap._http_json = fake
        return calls

    # --- 凭据 -------------------------------------------------------------
    def test_credentials_come_from_environment(self):
        self.assertEqual(snap._app_credentials(), ("cli_test_app", "test_secret"))

    def test_missing_secret_raises_before_any_request(self):
        os.environ.pop("FEISHU_APP_SECRET", None)
        calls = self._stub([])
        with self.assertRaises(snap.FeishuAuthError):
            snap.tenant_token()
        self.assertEqual(calls, [], "凭据缺失时不该发出任何请求")

    def test_app_id_can_fall_back_to_config(self):
        # 只有 app_id 允许写进 config.json；密钥永远只在环境变量里。
        os.environ.pop("FEISHU_APP_ID", None)
        saved = snap.CFG.get("feishu_app_id")
        snap.CFG["feishu_app_id"] = "cli_from_config"
        try:
            self.assertEqual(snap._app_credentials()[0], "cli_from_config")
        finally:
            snap.CFG["feishu_app_id"] = saved

    # --- token 生命周期 ---------------------------------------------------
    def test_token_is_cached(self):
        calls = self._stub([{"code": 0, "tenant_access_token": "t-1", "expire": 7200}])
        self.assertEqual(snap.tenant_token(), "t-1")
        self.assertEqual(snap.tenant_token(), "t-1")
        self.assertEqual(len(calls), 1, "有效期内第二次调用应命中缓存")

    def test_expired_token_is_refetched(self):
        self._stub([
            {"code": 0, "tenant_access_token": "t-1", "expire": 7200},
            {"code": 0, "tenant_access_token": "t-2", "expire": 7200},
        ])
        snap.tenant_token()
        snap._TOKEN_CACHE["expires_at"] = 0.0
        self.assertEqual(snap.tenant_token(), "t-2")

    def test_rejected_credentials_name_the_error_code(self):
        self._stub([{"code": 10003, "msg": "invalid param"}])
        with self.assertRaises(snap.FeishuAuthError) as ctx:
            snap.tenant_token()
        self.assertIn("10003", str(ctx.exception))

    # --- 信封与错误 -------------------------------------------------------
    def test_envelope_is_stripped(self):
        self._stub([
            {"code": 0, "tenant_access_token": "t", "expire": 7200},
            {"code": 0, "data": {"fields": ["A"], "has_more": False}},
        ])
        out = snap.feishu("GET", "/open-apis/base/v3/bases/b/tables/t/records")
        self.assertEqual(out, {"fields": ["A"], "has_more": False})

    def test_missing_data_becomes_empty_dict(self):
        self._stub([
            {"code": 0, "tenant_access_token": "t", "expire": 7200},
            {"code": 0},
        ])
        self.assertEqual(snap.feishu("POST", "/x"), {})

    def test_non_zero_code_raises_with_code_and_path(self):
        self._stub([
            {"code": 0, "tenant_access_token": "t", "expire": 7200},
            {"code": 99991672, "msg": "access denied: app has not applied for scope"},
        ])
        with self.assertRaises(snap.FeishuError) as ctx:
            snap.feishu("POST", "/open-apis/base/v3/bases/b/blocks/list")
        message = str(ctx.exception)
        self.assertIn("99991672", message)
        self.assertIn("blocks/list", message)

    def test_dead_token_is_retried_once(self):
        self._stub([
            {"code": 0, "tenant_access_token": "t-1", "expire": 7200},
            {"code": 99991661, "msg": "token expired"},
            {"code": 0, "tenant_access_token": "t-2", "expire": 7200},
            {"code": 0, "data": {"blocks": []}},
        ])
        self.assertEqual(snap.feishu("POST", "/x/blocks/list"), {"blocks": []})

    # --- 路径与红线 -------------------------------------------------------
    def test_base_path_uses_the_configured_base_token(self):
        self.assertEqual(
            snap.base_path("tables", "tblX", "records"),
            "/open-apis/base/v3/bases/test-base-token/tables/tblX/records",
        )

    def test_no_lark_cli_invocation_remains(self):
        """红线：传输层不得再 shell out 到 lark-cli，也不得写死 user 身份。"""
        with open(os.path.join(HERE, "snapshot.py"), encoding="utf-8") as fh:
            source = fh.read()
        self.assertNotIn('"+base', source)
        self.assertNotIn("--as\", \"user\"", source)
        self.assertNotIn("lark_cli", source)


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False, verbosity=2).result.wasSuccessful() else 1)
