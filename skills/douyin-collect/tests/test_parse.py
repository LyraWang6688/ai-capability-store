#!/usr/bin/env python3
"""离线测试：只测解析与查重的纯函数，不访问飞书、不联网。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from collect import dup_of, parse_share  # noqa: E402

SHARE = (
    "7.43 复制打开抖音，看看【杨迪的作品】#谁还没来学功夫练武术 今天的酒店和服装太适合"
    "拍这个了！ https://v.douyin.com/iRabc123/"
)


class ParseShareTest(unittest.TestCase):
    def test_full_share_text(self):
        p = parse_share(SHARE, resolve=False)
        self.assertEqual(p["author"], "杨迪")
        self.assertIn("学功夫练武术", p["title"])
        self.assertNotIn("http", p["title"])
        self.assertTrue(p["has_meta"])

    def test_bare_video_url_has_no_meta(self):
        p = parse_share("https://www.douyin.com/video/7684600094088026085", resolve=False)
        self.assertEqual(p["video_id"], "7684600094088026085")
        self.assertEqual(p["url"], "https://www.douyin.com/video/7684600094088026085")
        self.assertFalse(p["has_meta"])

    def test_modal_id_is_extracted(self):
        p = parse_share(
            "https://www.douyin.com/discover?modal_id=7690930099235592869",
            resolve=False,
        )
        self.assertEqual(p["video_id"], "7690930099235592869")

    def test_share_tail_is_stripped(self):
        p = parse_share(
            "【某某的作品】好看的转场 复制此链接，打开Dou音搜索，直接观看视频！"
            "https://v.douyin.com/xyz/",
            resolve=False,
        )
        self.assertEqual(p["author"], "某某")
        self.assertEqual(p["title"], "好看的转场")


class DupTest(unittest.TestCase):
    def test_match_by_video_id(self):
        rows = [
            {"参考视频": "[https://www.douyin.com/video/7684600094088026085]"
                        "(https://www.douyin.com/video/7684600094088026085)"},
            {"参考视频": "https://www.douyin.com/video/1111111111111111111"},
        ]
        parsed = {"video_id": "7684600094088026085",
                  "url": "https://www.douyin.com/video/7684600094088026085"}
        self.assertIs(dup_of(rows, parsed), rows[0])

    def test_no_match(self):
        rows = [{"参考视频": "https://www.douyin.com/video/2222222222222222222"}]
        parsed = {"video_id": "3333333333333333333",
                  "url": "https://www.douyin.com/video/3333333333333333333"}
        self.assertIsNone(dup_of(rows, parsed))


if __name__ == "__main__":
    unittest.main(verbosity=2)
