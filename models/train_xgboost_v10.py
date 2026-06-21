#!/usr/bin/env python3
"""
XGBoost Training Pipeline for Σ₀ V10 Scoring Model

Trains on real YouTube Shorts engagement data.
Outputs model weights + training report.

Usage:
    python models/train_xgboost_v10.py [--input-file features_v10.jsonl]

Output:
    models/sigma0_v10_xgb.json
    models/training_report.json
"""

import json
import sys
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, Tuple
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)

try:
    import xgboost as xgb
    import numpy as np
except ImportError:
    logger.error("Required: pip install xgboost numpy")
    sys.exit(1)


class XGBoostModelTrainer:
    """Train XGBoost on Σ₀ V10 features."""

    def __init__(self, input_dir: str = "data/youtube", model_dir: str = "models"):
        self.input_dir = Path(input_dir)
        self.model_dir = Path(model_dir)
        self.model_dir.mkdir(parents=True, exist_ok=True)

        self.feature_file = self.input_dir / "features_v10.jsonl"
        self.model_file = self.model_dir / "sigma0_v10_xgb.json"
        self.report_file = self.model_dir / "training_report.json"

        # Feature names for model interpretation
        self.feature_names = [
            # Engagement (ground truth)
            'log_views', 'like_ratio', 'comment_ratio', 'comments_per_like',
            # Σ₀ structural features
            'entropy_proxy', 'motion_proxy', 'hook_strength',
            'retention_proxy', 'velocity_score', 'surprise_gap',
            # Flags
            'is_gaming',
        ]

    def load_data(self) -> Tuple[np.ndarray, np.ndarray]:
        """Load features from JSONL file."""

        if not self.feature_file.exists():
            logger.error(f"Feature file not found: {self.feature_file}")
            return None, None

        features_list = []
        targets_list = []

        with open(self.feature_file, 'r') as f:
            for line_num, line in enumerate(f, 1):
                if not line.strip():
                    continue

                try:
                    record = json.loads(line)

                    engagement = record.get('engagement', {})
                    sigma0 = record.get('sigma0', {})

                    # Build feature vector
                    feature_vector = [
                        # Engagement features (normalized)
                        np.log(max(1, engagement.get('views', 1))) / 10.0,
                        min(1.0, engagement.get('like_ratio', 0) * 100),
                        min(1.0, engagement.get('comment_ratio', 0) * 100),
                        min(1.0, engagement.get('comments_per_like', 0)),
                        # Σ₀ features
                        sigma0.get('entropy_proxy', 0.5),
                        sigma0.get('motion_proxy', 0.5),
                        sigma0.get('hook_strength', 0.5),
                        sigma0.get('retention_proxy', 0.5),
                        sigma0.get('velocity_score', 0.5),
                        sigma0.get('surprise_gap', 0.5),
                        # Gaming flag
                        1.0 if record.get('is_gaming', False) else 0.0,
                    ]

                    target = record.get('target', 0.0)

                    features_list.append(feature_vector)
                    targets_list.append(target)

                except Exception as e:
                    logger.debug(f"Line {line_num}: {e}")
                    continue

                if line_num % 5000 == 0:
                    logger.info(f"Loaded {line_num} records...")

        X = np.array(features_list, dtype=np.float32)
        y = np.array(targets_list, dtype=np.float32)

        logger.info(f"Loaded {len(X)} samples, {X.shape[1]} features")

        return X, y

    def train(self, X: np.ndarray, y: np.ndarray) -> xgb.XGBRegressor:
        """Train XGBoost model."""

        if X is None or len(X) == 0:
            logger.error("No training data")
            return None

        # Train/test split
        split_idx = int(0.8 * len(X))
        X_train, X_test = X[:split_idx], X[split_idx:]
        y_train, y_test = y[:split_idx], y[split_idx:]

        logger.info(f"Train: {len(X_train)}, Test: {len(X_test)}")

        # Model hyperparameters (tuned for video scoring)
        model = xgb.XGBRegressor(
            n_estimators=500,
            max_depth=6,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            random_state=42,
            tree_method='hist',
            eval_metric='rmse',
            verbose=0
        )

        # Train with early stopping
        logger.info("Training XGBoost...")
        model.fit(
            X_train, y_train,
            eval_set=[(X_test, y_test)],
            early_stopping_rounds=50,
            verbose=False
        )

        # Evaluate
        train_score = model.score(X_train, y_train)
        test_score = model.score(X_test, y_test)

        logger.info(f"Train R²: {train_score:.4f}")
        logger.info(f"Test R²: {test_score:.4f}")

        # Feature importance
        importance = model.feature_importances_
        for name, imp in zip(self.feature_names, importance):
            if imp > 0.01:
                logger.info(f"  {name}: {imp:.4f}")

        return model

    def save_model(self, model: xgb.XGBRegressor) -> Dict[str, Any]:
        """Save model and report."""

        if model is None:
            logger.error("No model to save")
            return None

        # Save model
        model.save_model(str(self.model_file))
        logger.info(f"Model saved: {self.model_file}")

        # Generate report
        report = {
            'timestamp': datetime.utcnow().isoformat(),
            'model_file': str(self.model_file),
            'n_estimators': model.n_estimators,
            'max_depth': model.max_depth,
            'learning_rate': model.learning_rate,
            'feature_names': self.feature_names,
            'feature_importance': {
                name: float(imp)
                for name, imp in zip(self.feature_names, model.feature_importances_)
            },
            'status': 'trained',
        }

        with open(self.report_file, 'w') as f:
            json.dump(report, f, indent=2)

        logger.info(f"Report saved: {self.report_file}")

        return report


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Train XGBoost for Σ₀ V10")
    parser.add_argument("--input-dir", default="data/youtube", help="Feature directory")
    parser.add_argument("--input-file", default="features_v10.jsonl", help="Feature file")
    parser.add_argument("--model-dir", default="models", help="Model output directory")

    args = parser.parse_args()

    trainer = XGBoostModelTrainer(args.input_dir, args.model_dir)

    logger.info("Loading features...")
    X, y = trainer.load_data()

    if X is None:
        logger.error("Failed to load data")
        sys.exit(1)

    logger.info("Training model...")
    model = trainer.train(X, y)

    if model:
        logger.info("Saving model...")
        report = trainer.save_model(model)
        logger.info("✅ Training complete")
    else:
        logger.error("❌ Training failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
