"""Parser sanity for the V1 knowledge-boundary probe (#2850).

The boundary labels feed SFT training (Gekhman relabel): a parser false-negative marks a
CORRECT model answer as wrong -> mislabels it "I don't know" -> teaches over-abstention.
So the extractor must be right before any chain output is trusted.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "experiments", "v1_10_toy"))

from v1_boundary_probe import gold_answer, model_answer  # noqa: E402


def test_gold_extraction_basic():
    assert gold_answer("some steps\n#### 72") == "72"
    assert gold_answer("steps\n#### 1,000") == "1000"
    assert gold_answer("#### 3.5") == "3.5"


def test_model_answer_plain():
    assert model_answer("So she has 18 left. The answer is 18") == "18"


def test_model_answer_trailing_period():
    # The prompt DEMANDS "End with 'The answer is <number>.'" — the sentence period must
    # not become part of the number. This is the suspected source of the 24% artifact.
    assert model_answer("The answer is 72.") == "72"


def test_model_answer_decimal_vs_period():
    assert model_answer("The answer is 3.5.") == "3.5"
    assert model_answer("cost is $1,000. The answer is 1000.") == "1000"


def test_model_answer_negative():
    assert model_answer("The answer is -4.") == "-4"


def test_model_answer_commas():
    assert model_answer("The answer is 1,234.") == "1234"


def test_model_answer_number_then_words():
    assert model_answer("The answer is 42. Hope that helps!") == "42"
