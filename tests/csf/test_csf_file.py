"""Tests for CSF file format reader/writer."""

import tempfile
import unittest
from pathlib import Path

from csf.csf_file import MAGIC, CSFReader, CSFWriter, SymbolicDictionary
from csf.delta_stream import DeltaType


class TestSymbolicDictionary(unittest.TestCase):
    def test_builtin_anchors(self):
        sd = SymbolicDictionary()
        self.assertEqual(sd.encode_name("Garden"), 0x01)
        self.assertEqual(sd.encode_name("Lantern"), 0x03)
        self.assertEqual(sd.decode_code(0x01), "Garden")

    def test_dynamic_entries(self):
        sd = SymbolicDictionary()
        code = sd.encode_name("NewConcept")
        self.assertGreaterEqual(code, 0x80)
        self.assertEqual(sd.decode_code(code), "NewConcept")

    def test_roundtrip_serialization(self):
        sd = SymbolicDictionary()
        sd.encode_name("TestAnchor")
        sd.encode_name("AnotherOne")
        data = sd.to_bytes()
        sd2, offset = SymbolicDictionary.from_bytes(data)
        self.assertEqual(sd2.encode_name("Garden"), 0x01)
        self.assertEqual(sd2.decode_code(sd.encode_name("TestAnchor")), "TestAnchor")


class TestCSFFileRoundtrip(unittest.TestCase):
    def test_write_and_read(self):
        with tempfile.NamedTemporaryFile(suffix=".csf", delete=False) as f:
            path = Path(f.name)

        try:
            writer = CSFWriter()
            writer.set_baseline({0: 100, 42: 200, 531440: 50})
            writer.dictionary.encode_name("TestSymbol")
            writer.add_confirmation(0, (0,) * 12, extent=0xFF)
            writer.add_delta(4, DeltaType.LIGHT_CHANGED,
                             (1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), b"\x05")
            meta = writer.write(path)

            self.assertGreater(meta.total_bytes, 0)
            self.assertEqual(meta.delta_count, 2)

            reader = CSFReader(path)
            self.assertEqual(reader.metadata.version, (0, 3))
            self.assertEqual(reader.baseline[0], 100)
            self.assertEqual(reader.baseline[42], 200)
            self.assertGreater(reader.metadata.dictionary_size, 0)
        finally:
            path.unlink(missing_ok=True)

    def test_empty_file(self):
        with tempfile.NamedTemporaryFile(suffix=".csf", delete=False) as f:
            path = Path(f.name)

        try:
            writer = CSFWriter()
            writer.write(path)
            reader = CSFReader(path)
            self.assertEqual(reader.baseline, {})
            self.assertEqual(reader.records, [])
        finally:
            path.unlink(missing_ok=True)

    def test_large_delta_stream(self):
        with tempfile.NamedTemporaryFile(suffix=".csf", delete=False) as f:
            path = Path(f.name)

        try:
            writer = CSFWriter()
            writer.set_baseline({})
            for i in range(1000):
                pos = tuple([(i + d) % 3 for d in range(12)])
                writer.add_confirmation(0, pos)

            for i in range(50):
                pos = tuple([(i * 7 + d) % 3 for d in range(12)])
                writer.add_delta(4, DeltaType.LIGHT_CHANGED, pos, b"\x01")

            meta = writer.write(path)
            self.assertEqual(meta.delta_count, 1050)

            # File should be well under 20KB for 1050 records
            self.assertLess(meta.total_bytes, 20_000)
        finally:
            path.unlink(missing_ok=True)


class TestCSFFileIntegrity(unittest.TestCase):
    """Footer checksum must detect tampering and truncation on load."""

    def _write_sample(self, path: Path):
        writer = CSFWriter()
        writer.set_baseline({0: 100, 42: 200, 531440: 50})
        writer.dictionary.encode_name("TestSymbol")
        writer.add_confirmation(0, (0,) * 12, extent=0xFF)
        writer.add_delta(4, DeltaType.LIGHT_CHANGED,
                         (1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), b"\x05")
        writer.write(path)

    def test_clean_file_loads(self):
        with tempfile.NamedTemporaryFile(suffix=".csf", delete=False) as f:
            path = Path(f.name)
        try:
            self._write_sample(path)
            # Sanity: an untouched file verifies and parses.
            reader = CSFReader(path)
            self.assertEqual(reader.metadata.delta_count, 2)
        finally:
            path.unlink(missing_ok=True)

    def test_body_tamper_detected(self):
        with tempfile.NamedTemporaryFile(suffix=".csf", delete=False) as f:
            path = Path(f.name)
        try:
            self._write_sample(path)
            b = bytearray(path.read_bytes())
            b[len(b) // 2] ^= 0xFF  # flip a body byte (not the magic, not the footer)
            path.write_bytes(bytes(b))
            with self.assertRaises(ValueError):
                CSFReader(path)
        finally:
            path.unlink(missing_ok=True)

    def test_footer_tamper_detected(self):
        with tempfile.NamedTemporaryFile(suffix=".csf", delete=False) as f:
            path = Path(f.name)
        try:
            self._write_sample(path)
            b = bytearray(path.read_bytes())
            b[-1] ^= 0xFF  # corrupt the stored footer itself
            path.write_bytes(bytes(b))
            with self.assertRaises(ValueError):
                CSFReader(path)
        finally:
            path.unlink(missing_ok=True)

    def test_truncation_detected(self):
        with tempfile.NamedTemporaryFile(suffix=".csf", delete=False) as f:
            path = Path(f.name)
        try:
            self._write_sample(path)
            b = path.read_bytes()
            path.write_bytes(b[:-8])  # lop off part of the footer
            with self.assertRaises(ValueError):
                CSFReader(path)
        finally:
            path.unlink(missing_ok=True)

    def test_tiny_file_rejected(self):
        with tempfile.NamedTemporaryFile(suffix=".csf", delete=False) as f:
            path = Path(f.name)
        try:
            path.write_bytes(MAGIC + b"\x00\x03")  # too small to hold a footer
            with self.assertRaises(ValueError):
                CSFReader(path)
        finally:
            path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
