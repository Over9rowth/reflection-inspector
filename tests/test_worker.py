"""Python 侧单元测试：RLE、合成顺序、导出与元数据。

用标准库 unittest，不引入 pytest——这个项目只需要跑得起来的测试，不需要额外依赖。
运行：`.venv/Scripts/python -m unittest discover -s tests -p "test_*.py" -v`
"""
from __future__ import annotations

import json
import pathlib
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "worker"))

import compose  # noqa: E402
import rle  # noqa: E402


def rect_rle(shape: tuple[int, int], box: tuple[int, int, int, int]) -> dict:
    """按像素矩形生成 RLE。box = (x0, y0, x1, y1)，半开区间。"""
    mask = np.zeros(shape, dtype=np.uint8)
    x0, y0, x1, y1 = box
    mask[y0:y1, x0:x1] = 1
    return rle.encode(mask)


class RleTests(unittest.TestCase):
    def test_roundtrip_random(self) -> None:
        generator = np.random.default_rng(20261028)
        for shape in [(1, 1), (3, 7), (64, 33), (129, 200)]:
            for _ in range(5):
                mask = generator.integers(0, 2, size=shape).astype(np.uint8)
                encoded = rle.encode(mask)
                self.assertEqual(sum(encoded["counts"]), shape[0] * shape[1])
                self.assertTrue(all(c > 0 for c in encoded["counts"]))
                np.testing.assert_array_equal(rle.decode(encoded), mask)

    def test_all_zero_and_all_one(self) -> None:
        zeros = rle.encode(np.zeros((4, 5), dtype=np.uint8))
        self.assertEqual(zeros["start"], 0)
        self.assertEqual(zeros["counts"], [20])
        ones = rle.encode(np.ones((4, 5), dtype=np.uint8))
        self.assertEqual(ones["start"], 1)
        self.assertEqual(ones["counts"], [20])

    def test_rejects_bad_counts(self) -> None:
        with self.assertRaises(rle.RleError):
            rle.decode({"w": 4, "h": 4, "start": 0, "counts": [3, 3]})
        with self.assertRaises(rle.RleError):
            rle.decode({"w": 4, "h": 4, "start": 0, "counts": [0, 16]})
        with self.assertRaises(rle.RleError):
            rle.decode({"w": 0, "h": 4, "start": 0, "counts": []})

    def test_dilate_expands_by_exactly_n(self) -> None:
        mask = np.zeros((7, 7), dtype=bool)
        mask[3, 3] = True
        self.assertEqual(int(rle.dilate(mask, 0).sum()), 1)
        self.assertEqual(int(rle.dilate(mask, 1).sum()), 9)
        self.assertEqual(int(rle.dilate(mask, 2).sum()), 25)

    def test_cross_language_fixture_is_stable(self) -> None:
        """JS 端 `tests/rle.test.cjs` 读同一份夹具，两端必须逐字段相同。"""
        mask = np.zeros((6, 8), dtype=np.uint8)
        mask[1:3, 2:5] = 1
        mask[4, 6] = 1
        fixture = pathlib.Path(__file__).parent / "fixtures" / "rle-case.json"
        expected = json.loads(fixture.read_text(encoding="utf-8"))
        self.assertEqual(rle.encode(mask), expected)


class ComposeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.shape = (24, 24)
        base = np.zeros((24, 24, 4), dtype=np.uint8)
        ys, xs = np.mgrid[0:24, 0:24]
        base[:, :, 0] = (xs * 7) % 256
        base[:, :, 1] = (ys * 11) % 256
        base[:, :, 2] = (xs * ys * 3) % 256
        base[:, :, 3] = 255
        self.base = base

    def edits(self) -> tuple[dict, dict]:
        solid = {
            "kind": "solid",
            "rle": rect_rle(self.shape, (8, 8, 12, 12)),
            "color": [10, 20, 30],
            "expand": 0,
        }
        mosaic = {
            "kind": "mosaic",
            "rle": rect_rle(self.shape, (0, 0, 24, 24)),
            "block": 4,
        }
        return solid, mosaic

    def test_solid_wins_over_mosaic_regardless_of_edit_order(self) -> None:
        solid, mosaic = self.edits()
        forward = compose.compose(self.base, [solid, mosaic])
        backward = compose.compose(self.base, [mosaic, solid])
        np.testing.assert_array_equal(forward, backward)
        np.testing.assert_array_equal(forward[8:12, 8:12, 0], np.full((4, 4), 10))
        np.testing.assert_array_equal(forward[8:12, 8:12, 3], np.full((4, 4), 255))

    def test_mosaic_samples_from_post_solid_base(self) -> None:
        """关键回归：马赛克不能回原图取样，否则实心边缘会把原内容混进邻块。"""
        solid, mosaic = self.edits()
        composed = compose.compose(self.base, [solid, mosaic])
        # 实心区所在块是 (8..12)，块 8..11 全部被实心覆盖，因此该块均值应恰为实心色。
        block = composed[8:12, 8:12, 0]
        self.assertTrue(np.all(block == 10), f"块内应被实心色填满，实际 {block}")

    def test_later_solid_overrides_earlier(self) -> None:
        first = {
            "kind": "solid",
            "rle": rect_rle(self.shape, (0, 0, 24, 24)),
            "color": [1, 2, 3],
            "expand": 0,
        }
        second = {
            "kind": "solid",
            "rle": rect_rle(self.shape, (4, 4, 8, 8)),
            "color": [200, 100, 50],
            "expand": 0,
        }
        out = compose.compose(self.base, [first, second])
        np.testing.assert_array_equal(out[5, 5, :3], [200, 100, 50])
        np.testing.assert_array_equal(out[0, 0, :3], [1, 2, 3])

    def test_transparent_pixels_have_zero_rgb(self) -> None:
        base = self.base.copy()
        base[2:5, 2:5, 3] = 0
        out = compose.compose(base, [])
        self.assertTrue(np.all(out[2:5, 2:5, :3] == 0))
        self.assertTrue(np.all(out[2:5, 2:5, 3] == 0))

    def test_does_not_mutate_input(self) -> None:
        before = self.base.copy()
        solid, mosaic = self.edits()
        compose.compose(self.base, [solid, mosaic])
        np.testing.assert_array_equal(self.base, before)

    def test_rejects_unknown_edit_and_wrong_size(self) -> None:
        with self.assertRaises(compose.EditError):
            compose.compose(self.base, [{"kind": "blur", "rle": {}}])
        wrong = rect_rle((5, 5), (0, 0, 2, 2))
        with self.assertRaises(compose.EditError):
            compose.compose(self.base, [{"kind": "solid", "rle": wrong, "color": [0, 0, 0]}])

    def test_mosaic_block_size_minimum(self) -> None:
        _, mosaic = self.edits()
        mosaic = dict(mosaic, block=1)
        with self.assertRaises(compose.EditError):
            compose.compose(self.base, [mosaic])


class ExportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.source = self.root / "source.png"
        image = Image.fromarray(self._pixels(), mode="RGBA")
        image.save(self.source, format="PNG")
        self.shape = (32, 32)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _pixels(self, shift: int = 0) -> np.ndarray:
        ys, xs = np.mgrid[0:32, 0:32]
        arr = np.zeros((32, 32, 4), dtype=np.uint8)
        arr[:, :, 0] = (xs * 5 + shift) % 256
        arr[:, :, 1] = (ys * 3) % 256
        arr[:, :, 2] = (xs + ys) % 256
        arr[:, :, 3] = 255
        return arr

    def test_export_writes_png_and_strips_metadata(self) -> None:
        out = self.root / "out.png"
        solid = {
            "kind": "solid",
            "rle": rect_rle(self.shape, (4, 4, 12, 12)),
            "color": [255, 0, 0],
            "expand": 1,
        }
        report = compose.export(self.source, [solid], out, fmt="png")
        self.assertTrue(out.is_file())
        self.assertEqual((report["width"], report["height"]), (32, 32))
        self.assertEqual(report["metadataStripped"], True)
        with Image.open(out) as check:
            self.assertEqual(check.mode, "RGBA")
            self.assertFalse(check.getexif())
            self.assertFalse(check.info.get("icc_profile"))
            pixels = np.asarray(check.convert("RGBA"))
        np.testing.assert_array_equal(pixels[5, 5], [255, 0, 0, 255])
        self.assertTrue(report["previewPngBase64"].startswith("iVBOR"))

    def test_replacement_invariance_under_solid_mask(self) -> None:
        """设计 §5 的核心检查：只改实心掩码覆盖的源像素，成品必须逐字节相同。"""
        solid = {
            "kind": "solid",
            "rle": rect_rle(self.shape, (8, 8, 16, 16)),
            "color": [0, 128, 255],
            "expand": 1,
        }
        first = self.root / "a.png"
        compose.export(self.source, [solid], first, fmt="png")

        tampered = self._pixels(shift=0)
        masked = compose.solid_union([solid], self.shape)
        tampered[masked, 0] = 200
        tampered[masked, 1] = 30
        tampered[masked, 2] = 90
        tampered[masked, 3] = 7  # 连 alpha 一起改，实心填充必须把它压回 255
        Image.fromarray(tampered, mode="RGBA").save(self.source, format="PNG")

        second = self.root / "b.png"
        compose.export(self.source, [solid], second, fmt="png")
        self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_refuses_to_overwrite_source(self) -> None:
        with self.assertRaises(compose.EditError):
            compose.export(self.source, [], self.source, fmt="png")

    def test_jpeg_flattens_alpha_over_background(self) -> None:
        arr = self._pixels()
        arr[0:8, 0:8, 3] = 0
        Image.fromarray(arr, mode="RGBA").save(self.source, format="PNG")
        out = self.root / "flat.jpg"
        compose.export(self.source, [], out, fmt="jpeg", background=(0, 0, 0))
        with Image.open(out) as check:
            self.assertEqual(check.mode, "RGB")
            pixel = check.convert("RGB").getpixel((0, 0))
        self.assertTrue(all(v <= 8 for v in pixel), f"透明区应合成为黑色，实际 {pixel}")


if __name__ == "__main__":
    unittest.main()
