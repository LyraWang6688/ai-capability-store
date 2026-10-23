"""Regression checks for event paths, timing guards and untrusted diagram text."""
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
loader = importlib.util.spec_from_file_location("motion", HERE / "render_motion.py")
motion = importlib.util.module_from_spec(loader)
loader.loader.exec_module(motion)


class MotionTests(unittest.TestCase):
    def setUp(self):
        self.spec = json.loads((HERE.parent / "assets/examples/loop.json").read_text())

    def test_retry_sequence_survives_normalization(self):
        result = motion.normalize(self.spec)
        self.assertEqual([e["node"] for e in result["events"]],
                         ["observe", "decide", "act", "check", "observe", "decide", "act", "check", "done"])
        self.assertEqual(result["events"][3]["status"], "failed")
        self.assertEqual(result["events"][-1]["status"], "complete")
        self.assertNotEqual(motion.route(3, 0)[0][1], motion.route(3, 0)[-1][1])
        self.assertEqual(motion.point_on(motion.route(3, 0), 1), motion.route(3, 0)[-1])

    def test_invalid_event_inputs_are_rejected(self):
        for duration in (0, -.5, float("nan"), float("inf"), True, "2", 13):
            with self.subTest(duration=duration), self.assertRaises(ValueError):
                spec = copy.deepcopy(self.spec)
                spec["events"][0]["duration"] = duration
                motion.normalize(spec)
        for change in ({"node": "missing"}, {"status": "invented"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                spec = copy.deepcopy(self.spec)
                spec["events"][0].update(change)
                motion.normalize(spec)

    def test_duplicate_nodes_and_decorative_sequence_are_rejected(self):
        spec = copy.deepcopy(self.spec)
        spec["nodes"][1]["id"] = spec["nodes"][0]["id"]
        with self.assertRaises(ValueError):
            motion.normalize(spec)
        spec = copy.deepcopy(self.spec)
        for e in spec["events"]:
            e["node"] = "observe"
        with self.assertRaises(ValueError):
            motion.normalize(spec)

    def test_sources_and_fitting_are_required(self):
        spec = copy.deepcopy(self.spec)
        spec.pop("source")
        with self.assertRaises(ValueError):
            motion.normalize(spec)
        spec = copy.deepcopy(self.spec)
        spec["nodes"][0]["label"] = "长" * 100
        with self.assertRaises(ValueError):
            motion.validate_text(spec)

    def test_untrusted_text_does_not_break_script_or_markup(self):
        spec = copy.deepcopy(self.spec)
        attack = '</script><script>throw 42</script><img src=x onerror=alert(1)>'
        spec["title"] = attack
        spec["events"][0]["caption"] = attack
        spec = motion.normalize(spec)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "animation.html"
            motion.render_html(spec, output)
            page = output.read_text()
            self.assertEqual(page.count("<script>"), 1)
            self.assertEqual(page.count("</script>"), 1)
            self.assertNotIn("<img", page)
            if shutil.which("node"):
                script = page.split("<script>")[1].split("</script>")[0]
                js = Path(directory) / "animation.js"
                js.write_text(script)
                subprocess.run(["node", "--check", str(js)], check=True, capture_output=True)

    @unittest.skipUnless(shutil.which("node"), "Node required for offline control logic check")
    def test_play_pause_scrub_replay_and_final_state(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "animation.html"
            motion.render_html(motion.normalize(self.spec), output)
            script = output.read_text().split("<script>")[1].split("</script>")[0]
            # A DOM stub verifies state transitions, not browser layout or real SVG geometry.
            harness = r"""
const assert=require('node:assert/strict');
class Element {constructor(){this.attrs={};this.style={};this.children=[];this.value='1'}setAttribute(k,v){this.attrs[k]=v}replaceChildren(){this.children=[]}append(e){this.children.push(e)}getTotalLength(){return 100}getPointAtLength(v){return {x:v,y:0}}}
const elements={};let raf;
const document={getElementById:k=>elements[k]||(elements[k]=new Element()),querySelector:k=>elements[k]||(elements[k]=new Element()),createElementNS:()=>new Element()};
const matchMedia=()=>({matches:true});const requestAnimationFrame=f=>{raf=f};
"""
            assertions = r"""
assert.equal(paused,true);assert.equal(play.textContent,'播放');
play.onclick();assert.equal(paused,false);raf(0);raf(2100);assert.ok(time>2);
play.onclick();const stopped=time;raf(2500);assert.equal(time,stopped);
seek.value=7.4;seek.oninput();assert.equal(paused,true);assert.equal(status.textContent,'5 / 9');assert.ok(travel.attrs.d.includes('888'));
seek.value=total;seek.oninput();assert.equal(status.textContent,'9 / 9');assert.equal(document.querySelector('#node-4 rect').attrs.stroke,'#00a63c');
document.getElementById('replay').onclick();assert.equal(time,0);assert.equal(paused,false);
"""
            js = Path(directory) / "controls.js"
            js.write_text(harness + script + assertions)
            subprocess.run(["node", str(js)], check=True, capture_output=True)


if __name__ == "__main__":
    unittest.main()
