#!/usr/bin/env python3
"""
Σ₀ V10 Feature Extractor — Real engagement features for XGBoost training

Converts YouTube Shorts metadata into features for the V10 model.
Designed to map to Σ₀ theoretical framework.

Input:  data/youtube/{gaming_,}shorts.jsonl
Output: data/youtube/features_v10.jsonl
"""

import json
import math
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, List
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)


class SigmaZeroFeatureExtractor:
    """
    Extract Σ₀-aligned features from YouTube Shorts metadata.

    Feature categories:
    1. Engagement metrics (real data)
    2. Σ₀ structural proxies (derived)
    """

    def __init__(self):
        self.now = datetime.utcnow()

    # ─── ENGAGEMENT METRICS (Ground Truth) ───

    def extract_engagement_metrics(self, record: Dict[str, Any]) -> Dict[str, float]:
        """Extract raw engagement metrics from metadata."""

        views = float(record.get('views', 1))
        likes = float(record.get('likes', 0))
        comments = float(record.get('comments', 0))
        duration = float(record.get('duration', 30))

        # Prevent division by zero
        views = max(1, views)

        return {
            'views': views,
            'likes': likes,
            'comments': comments,
            'duration': duration,
            'engagement_rate': (likes + comments) / views,
            'like_ratio': likes / views,
            'comment_ratio': comments / views,
            'comments_per_like': comments / max(1, likes),
        }

    # ─── Σ₀ STRUCTURAL PROXIES ───

    def entropy_proxy(self, record: Dict[str, Any]) -> float:
        """
        Entropy proxy from title/description randomness.
        Σ₀ theory: low entropy = collapse indicator.

        Heuristic: title with varied punctuation, capitals, rare words = high entropy.
        """

        title = record.get('title', '')
        description = record.get('description', '')
        text = (title + ' ' + description).lower()

        if not text:
            return 0.0

        # Count unique characters as entropy proxy
        unique_chars = len(set(text))
        max_chars = 26 + 10 + 5  # letters + digits + punctuation

        # Count transitions (changes between character types)
        transitions = 0
        for i in range(1, len(text)):
            if text[i-1].isalpha() != text[i].isalpha():
                transitions += 1
            if text[i-1].isdigit() != text[i].isdigit():
                transitions += 1

        # Normalize
        entropy = (unique_chars / max_chars) * 0.5 + (transitions / len(text)) * 0.5

        return min(1.0, entropy)

    def motion_proxy(self, record: Dict[str, Any]) -> float:
        """
        Motion proxy from keywords and engagement velocity.
        Σ₀ theory: low motion = static, low-engagement content.

        Heuristic: action keywords (kill, clutch, epic, insane) + fast growth.
        """

        title = record.get('title', '').lower()
        tags = [t.lower() for t in record.get('tags', [])]
        text = title + ' ' + ' '.join(tags)

        motion_keywords = {
            'kill', 'clutch', 'epic', 'insane', 'crazy', 'sick',
            'fail', 'funny', 'unbelievable', 'impossible', 'moment',
            'montage', 'gameplay', 'action', 'fight', 'battle'
        }

        keyword_score = sum(1 for kw in motion_keywords if kw in text) / len(motion_keywords)

        # Age-adjusted velocity
        age_days = self._days_old(record)
        views = float(record.get('views', 1))
        velocity = math.log(max(1, views / max(1, age_days))) / 10.0  # Normalized

        motion = (keyword_score * 0.6 + velocity * 0.4)

        return min(1.0, max(0.0, motion))

    def hook_strength(self, record: Dict[str, Any]) -> float:
        """
        Hook strength proxy (0-3s importance).
        Σ₀ theory: weak hooks = collapse into boring.

        Heuristic: opening keyword density, all-caps ratio.
        """

        title = record.get('title', '')

        if not title:
            return 0.5  # Neutral

        # All-caps ratio (often signals excitement)
        upper_ratio = sum(1 for c in title if c.isupper()) / max(1, len(title))

        # Hook keywords at start
        hook_keywords = {'insane', 'best', 'ultimate', 'epic', 'crazy', 'impossible'}
        first_words = title.split()[:3]
        hook_hit = any(w.lower().strip('!?.') in hook_keywords for w in first_words)

        # Punctuation (exclamation = high energy)
        punct_ratio = title.count('!') / max(1, len(title))

        hook = (0.3 * upper_ratio + 0.4 * (1.0 if hook_hit else 0.0) + 0.3 * punct_ratio)

        return min(1.0, hook)

    def retention_proxy(self, record: Dict[str, Any]) -> float:
        """
        Retention proxy (completion likelihood).
        Σ₀ theory: low retention = collapse onto null manifold.

        Heuristic: comment ratio (high engagement = high retention),
                   duration efficiency (short = easier to complete).
        """

        duration = float(record.get('duration', 30))
        comment_ratio = self._safe_divide(
            float(record.get('comments', 0)),
            float(record.get('views', 1))
        )

        # Shorter videos have inherent advantage (easier to complete)
        duration_score = 1.0 - (duration / 60.0)  # 30s = 0.5, 60s = 0.0

        # High comment ratio = people cared enough to comment
        comment_score = min(1.0, comment_ratio * 100)

        retention = (duration_score * 0.4 + comment_score * 0.6)

        return min(1.0, retention)

    def velocity_score(self, record: Dict[str, Any]) -> float:
        """
        Viral velocity: views per day since publication.
        """

        views = float(record.get('views', 1))
        age_days = max(0.1, self._days_old(record))  # Prevent division by zero

        # Log scale for interpretability
        velocity = math.log(views / age_days + 1) / 5.0

        return min(1.0, velocity)

    def surprise_gap(self, record: Dict[str, Any]) -> float:
        """
        Surprise gap: mismatch between expected and actual engagement.
        Σ₀ theory: large gap = system miscalibrated (collapse imminent).

        Heuristic: views >> comments would suggest model overconfidence.
        """

        engagement_rate = self._safe_divide(
            float(record.get('likes', 0)) + float(record.get('comments', 0)),
            float(record.get('views', 1))
        )

        # Typical Shorts engagement: 0.5-5% CTR
        expected_rate = 0.02
        gap = abs(engagement_rate - expected_rate) / max(expected_rate, 0.001)

        # Clamp to [0, 1]
        return min(1.0, gap / 10.0)

    # ─── UTILITY ───

    def _days_old(self, record: Dict[str, Any]) -> float:
        """Days since publication."""

        pub_date_str = record.get('publish_date', '')
        if not pub_date_str:
            return 1.0

        try:
            pub_date = datetime.fromisoformat(pub_date_str.replace('Z', '+00:00'))
            delta = (self.now - pub_date).total_seconds() / 86400.0
            return max(0.1, delta)
        except:
            return 1.0

    def _safe_divide(self, numerator: float, denominator: float) -> float:
        """Divide with zero-safety."""
        return numerator / max(denominator, 1e-8)

    # ─── MAIN EXTRACTION ───

    def extract_features(self, record: Dict[str, Any]) -> Dict[str, Any]:
        """
        Extract all features for a single YouTube Shorts record.

        Returns:
            {
                'video_id': str,
                'engagement': {...},
                'sigma0': {...},
                'target': float (for training)
            }
        """

        engagement = self.extract_engagement_metrics(record)

        sigma0 = {
            'entropy_proxy': self.entropy_proxy(record),
            'motion_proxy': self.motion_proxy(record),
            'hook_strength': self.hook_strength(record),
            'retention_proxy': self.retention_proxy(record),
            'velocity_score': self.velocity_score(record),
            'surprise_gap': self.surprise_gap(record),
        }

        # Target label for training: engagement signal
        # Scale: log(views) + weighted metrics
        target = (
            math.log(max(1, engagement['views'])) / 10.0 +
            engagement['like_ratio'] * 50.0 +
            engagement['comment_ratio'] * 100.0
        )

        return {
            'video_id': record.get('video_id', ''),
            'title': record.get('title', ''),
            'is_gaming': record.get('is_gaming', False),
            'engagement': engagement,
            'sigma0': sigma0,
            'target': min(100.0, target),  # Cap for training stability
        }


class FeatureExtractionPipeline:
    """Process entire JSONL dataset."""

    def __init__(self, input_dir: str = "data/youtube", output_dir: str = "data/youtube"):
        self.input_dir = Path(input_dir)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

        self.extractor = SigmaZeroFeatureExtractor()

    def process_dataset(self, input_file: str = "raw_shorts_dataset.jsonl") -> Dict[str, int]:
        """
        Process raw dataset into features.

        Args:
            input_file: JSONL file with YouTube Shorts metadata

        Returns:
            {"processed": int, "errors": int}
        """

        input_path = self.input_dir / input_file
        output_path = self.output_dir / "features_v10.jsonl"

        if not input_path.exists():
            logger.error(f"Input file not found: {input_path}")
            return {"processed": 0, "errors": 0}

        processed = 0
        errors = 0

        with open(input_path, 'r') as in_f, open(output_path, 'w') as out_f:
            for line_num, line in enumerate(in_f, 1):
                if not line.strip():
                    continue

                try:
                    record = json.loads(line)
                    features = self.extractor.extract_features(record)
                    out_f.write(json.dumps(features) + '\n')
                    processed += 1
                except Exception as e:
                    logger.warning(f"Line {line_num}: {e}")
                    errors += 1

                if line_num % 1000 == 0:
                    logger.info(f"Processed {line_num} records...")

        logger.info(f"✅ Feature extraction complete: {processed} processed, {errors} errors")
        logger.info(f"Output: {output_path}")

        return {"processed": processed, "errors": errors}


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Extract Σ₀ V10 features from YouTube Shorts")
    parser.add_argument(
        "--input-file",
        default="raw_shorts_dataset.jsonl",
        help="Input JSONL file"
    )
    parser.add_argument(
        "--input-dir",
        default="data/youtube",
        help="Input directory"
    )
    parser.add_argument(
        "--output-dir",
        default="data/youtube",
        help="Output directory"
    )

    args = parser.parse_args()

    pipeline = FeatureExtractionPipeline(args.input_dir, args.output_dir)
    stats = pipeline.process_dataset(args.input_file)

    if stats["processed"] > 0:
        logger.info(f"Successfully processed {stats['processed']} records")
    else:
        logger.error("Failed to process any records")


if __name__ == "__main__":
    main()
