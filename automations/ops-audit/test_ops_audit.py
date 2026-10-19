#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ops-audit 的离线测试。

原则：**不联网、不 SSH、不读真实历史**。所有输入都是构造的夹具，
所以这个测试可以在任何机器、任何 CI 上跑。

    python3 test_ops_audit.py
"""

import unittest
from datetime import date

import ops_audit as oa

TH = {
    "disk_warn": 85, "disk_crit": 92, "inode_warn": 85,
    "mem_avail_warn_mb": 150, "load_warn_ratio": 1.0,
    "cert_warn_days": 21, "restart_delta_warn": 5, "disk_delta_warn": 5,
}

SERVER_FIXTURE = """\
HOSTNAME=VM-0-11-ubuntu
UPTIME_DAYS=33
LOAD1=0.08
NPROC=2
MEM_TOTAL_MB=1931
MEM_AVAIL_MB=760
SWAP_TOTAL_MB=4095
SWAP_USED_MB=1468
SWAP_SI=0
SWAP_SO=0
DISK_PCT=37
DISK_FREE_GB=23
INODE_PCT=13
NGINX_TEST=ok
OOM_COUNT=0
PORT_5000=200
PORT_3011=307
PM2=box2bitable-server|online|343
PM2=pm2-logrotate|online|12
DOCKER=meeting-analysis|Up 29 hours
CERT=meeting.example.com|86
CERT=api.example.com|54
CERT=old.example.com|40
PROJECT=/opt/box2bitable|git@github.com:someone/feishu-retail-ops.git
PROJECT=/home/ubuntu/meeting-analysis|git@github.com:someone/Teaming-Bot.git
"""


class TestParseServerFacts(unittest.TestCase):
    def setUp(self):
        self.facts = oa.parse_server_facts(SERVER_FIXTURE)

    def test_kv(self):
        self.assertEqual(self.facts["kv"]["DISK_PCT"], "37")
        self.assertEqual(self.facts["kv"]["PORT_5000"], "200")

    def test_pm2(self):
        self.assertEqual(len(self.facts["pm2"]), 2)
        self.assertEqual(self.facts["pm2"][0]["name"], "box2bitable-server")
        self.assertEqual(self.facts["pm2"][0]["status"], "online")
        self.assertEqual(self.facts["pm2"][0]["restarts"], 343)

    def test_docker(self):
        self.assertEqual(self.facts["docker"][0]["name"], "meeting-analysis")

    def test_certs(self):
        self.assertEqual(self.facts["certs"]["meeting.example.com"], 86)

    def test_projects(self):
        self.assertEqual(len(self.facts["projects"]), 2)
        self.assertTrue(self.facts["projects"][0]["remote"].endswith(".git"))

    def test_garbage_is_ignored(self):
        facts = oa.parse_server_facts("hello\n\n=nokey\nBADLINE")
        self.assertEqual(facts["kv"], {})
        self.assertEqual(facts["pm2"], [])


class TestHealthIssues(unittest.TestCase):
    def facts(self, **kv_over):
        f = oa.parse_server_facts(SERVER_FIXTURE)
        f["kv"].update({k: str(v) for k, v in kv_over.items()})
        return f

    def test_healthy(self):
        hosts = {"meeting.example.com", "api.example.com"}
        issues, unused = oa.health_issues(self.facts(), {"meeting": "307", "api": "200"}, {}, TH,
                                          domain_hosts=hosts)
        self.assertEqual(issues, [])
        self.assertEqual(unused, ["old.example.com"])

    def test_disk_warn_and_crit(self):
        i, _ = oa.health_issues(self.facts(DISK_PCT=86), {}, {}, TH)
        self.assertTrue(any("磁盘 86%" in t for _, t in i))
        i, _ = oa.health_issues(self.facts(DISK_PCT=95), {}, {}, TH)
        self.assertTrue(any(lv == "🔴" and "磁盘" in t for lv, t in i))

    def test_low_memory(self):
        i, _ = oa.health_issues(self.facts(MEM_AVAIL_MB=100), {}, {}, TH)
        self.assertTrue(any("可用内存仅 100MB" in t for _, t in i))

    def test_active_swap(self):
        i, _ = oa.health_issues(self.facts(SWAP_SI=500, SWAP_SO=300, SWAP_ACTIVE=3), {}, {}, TH)
        self.assertTrue(any("持续换页" in t for _, t in i))

    def test_transient_swap_ignored(self):
        i, _ = oa.health_issues(self.facts(SWAP_SI=8, SWAP_SO=0, SWAP_ACTIVE=1), {}, {}, TH)
        self.assertFalse(any("换页" in t for _, t in i))

    def test_high_load(self):
        i, _ = oa.health_issues(self.facts(LOAD1=4.0, NPROC=2), {}, {}, TH)
        self.assertTrue(any("负载" in t for _, t in i))

    def test_pm2_down(self):
        f = self.facts()
        f["pm2"][0]["status"] = "errored"
        i, _ = oa.health_issues(f, {}, {}, TH)
        self.assertTrue(any("pm2 进程异常" in t for _, t in i))

    def test_nginx_fail(self):
        i, _ = oa.health_issues(self.facts(NGINX_TEST="fail"), {}, {}, TH)
        self.assertTrue(any("nginx" in t for _, t in i))

    def test_domain_down(self):
        i, _ = oa.health_issues(self.facts(), {"meeting": "000"}, {}, TH)
        self.assertTrue(any(lv == "🔴" and "meeting" in t for lv, t in i))

    def test_cert_expiring(self):
        f = self.facts()
        f["certs"]["api"] = 10
        i, _ = oa.health_issues(f, {}, {}, TH)
        self.assertTrue(any("证书 api" in t for _, t in i))

    def test_unused_certs_detected(self):
        hosts = {"meeting.example.com", "api.example.com"}
        _, unused = oa.health_issues(self.facts(), {}, {}, TH, domain_hosts=hosts)
        self.assertIn("old.example.com", unused)

    def test_oom(self):
        i, _ = oa.health_issues(self.facts(OOM_COUNT=3), {}, {}, TH)
        self.assertTrue(any("OOM" in t for _, t in i))


class TestExpectedIssues(unittest.TestCase):
    def test_missing_everything(self):
        facts = oa.parse_server_facts("PM2=other|online|1\n")
        issues = oa.expected_issues(facts, {"pm2": ["api"], "docker": ["web"], "ports": [9999]},
                                    {"web": "000"})
        text = " ".join(t for _, t in issues)
        self.assertIn("pm2 进程 api", text)
        self.assertIn("容器 web", text)
        self.assertIn("端口 9999", text)

    def test_all_present(self):
        facts = oa.parse_server_facts(SERVER_FIXTURE)
        issues = oa.expected_issues(facts, {"pm2": ["box2bitable-server"],
                                            "docker": ["meeting-analysis"],
                                            "ports": [5000, 3011]}, {})
        self.assertEqual(issues, [])


class TestDelta(unittest.TestCase):
    def test_disk_jump(self):
        facts = oa.parse_server_facts(SERVER_FIXTURE)
        issues = oa.delta_issues(facts, {"disk_pct": 30}, TH)
        self.assertTrue(any("磁盘环比" in t for _, t in issues))

    def test_restart_jump(self):
        facts = oa.parse_server_facts(SERVER_FIXTURE)
        issues = oa.delta_issues(facts, {"pm2_restarts": {"box2bitable-server": 330}}, TH)
        self.assertTrue(any("崩溃循环" in t for _, t in issues))

    def test_no_prev(self):
        facts = oa.parse_server_facts(SERVER_FIXTURE)
        self.assertEqual(oa.delta_issues(facts, {}, TH), [])


class TestProjectVerdict(unittest.TestCase):
    today = date(2026, 10, 19)

    def test_archived(self):
        v, _ = oa.classify_project({"isArchived": True, "pushedAt": "2026-10-01"}, "2026-10-01", self.today, 180)
        self.assertEqual(v, "已归档")

    def test_deleted(self):
        v, _ = oa.classify_project(None, None, self.today, 180)
        self.assertEqual(v, "已删除")

    def test_active(self):
        v, idle = oa.classify_project({"isArchived": False}, "2026-10-15", self.today, 180)
        self.assertEqual(v, "活跃")
        self.assertEqual(idle, 4)

    def test_inactive(self):
        v, idle = oa.classify_project({"isArchived": False}, "2026-01-01", self.today, 180)
        self.assertEqual(v, "不活跃")
        self.assertGreater(idle, 180)

    def test_bad_date_does_not_crash(self):
        v, _ = oa.classify_project({"isArchived": False}, "not-a-date", self.today, 180)
        self.assertEqual(v, "活跃")


class TestRepoSlug(unittest.TestCase):
    def test_ssh(self):
        self.assertEqual(oa.repo_slug_from_remote("git@github.com:owner/repo.git"), "owner/repo")

    def test_https(self):
        self.assertEqual(oa.repo_slug_from_remote("https://github.com/owner/repo.git"), "owner/repo")

    def test_no_git_suffix(self):
        self.assertEqual(oa.repo_slug_from_remote("https://github.com/owner/repo"), "owner/repo")

    def test_non_github(self):
        self.assertEqual(oa.repo_slug_from_remote("git@gitlab.com:owner/repo.git"), "")

    def test_empty(self):
        self.assertEqual(oa.repo_slug_from_remote(""), "")


class TestConfigAndReport(unittest.TestCase):
    def cfg(self):
        return oa.deep_merge(oa.DEFAULTS, {
            "server": {"host": "203.0.113.10"},
            "domains": {"web": "web.example.com"},
            "expect": {"pm2": ["api"], "docker": ["web"], "ports": [5000]},
            "repos": {"owner": "someone"},
        })

    def test_deep_merge_keeps_defaults(self):
        cfg = self.cfg()
        self.assertEqual(cfg["thresholds"]["disk_warn"], 85)
        self.assertEqual(cfg["server"]["ssh_user"], "ubuntu")

    def test_render_contains_sections(self):
        cfg = self.cfg()
        health = {
            "issues": [("🟡", "磁盘 86%")], "domains": {"web": "200"},
            "certs": {"web.example.com": 86},
            "facts": oa.parse_server_facts(SERVER_FIXTURE),
        }
        projects = [{"slug": "o/r", "path": "/opt/r", "verdict": "活跃", "idle_days": 2}]
        md = oa.render_report(cfg, "2026-10-19", health, projects, {})
        for token in ("总体", "服务器", "域名可达性", "证书", "部署项目", "磁盘 86%"):
            self.assertIn(token, md)

    def test_render_archived_project_warns(self):
        cfg = self.cfg()
        health = {"issues": [], "domains": {}, "certs": {}, "facts": {"kv": {}}}
        projects = [{"slug": "o/old", "path": "/opt/old", "verdict": "已归档", "idle_days": None}]
        md = oa.render_report(cfg, "2026-10-19", health, projects, {})
        self.assertIn("建议退休", md)
        self.assertIn("需人工确认", md)


class TestHtmlReport(unittest.TestCase):
    def cfg(self):
        return oa.deep_merge(oa.DEFAULTS, {
            "server": {"host": "203.0.113.10"},
            "domains": {"web": "web.example.com"},
            "expect": {"pm2": ["api"], "docker": ["web"], "ports": [5000]},
            "repos": {"owner": "someone"},
        })

    def health(self, issues=None):
        return {
            "issues": issues or [], "domains": {"web": "200"},
            "certs": {"web.example.com": 90},
            "facts": oa.parse_server_facts(SERVER_FIXTURE),
        }

    def test_html_structure(self):
        html = oa.render_html(self.cfg(), "2026-10-19", self.health(),
                              [{"slug": "o/r", "path": "/opt/r", "verdict": "活跃", "idle_days": 2}], {})
        self.assertIn("<!DOCTYPE html>", html)
        self.assertIn("服务器月度体检", html)
        self.assertIn("VM-0-11-ubuntu", html)   # 来自夹具 HOSTNAME
        self.assertIn("o/r", html)
        self.assertIn("部署项目", html)

    def test_html_marks_retirement(self):
        html = oa.render_html(self.cfg(), "2026-10-19", self.health(),
                              [{"slug": "o/old", "path": "/opt/old", "verdict": "已归档", "idle_days": None}], {})
        self.assertIn("建议退休", html)
        self.assertIn("需人工确认", html)

    def test_html_shows_issues(self):
        html = oa.render_html(self.cfg(), "2026-10-19", self.health([("🔴", "磁盘 95%")]),
                              [], {})
        self.assertIn("磁盘 95%", html)
        self.assertIn("有阻断问题", html)

    def test_html_escapes_nothing_dangerous(self):
        html = oa.render_html(self.cfg(), "2026-10-19", self.health(), [], {})
        self.assertNotIn("<script", html.lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
