import abc
from typing import Any, Dict, List, Optional, Tuple


class DriftAxisCanary(abc.ABC):
    """Abstract base class for a canary that monitors a specific axis of agent drift."""

    @abc.abstractmethod
    def measure_drift(self, current_state: Any, baseline_state: Any) -> float:
        """
        Measures the drift along this axis between the current and baseline states.

        Args:
            current_state: The current state or output of the agent relevant to this canary.
            baseline_state: The expected or baseline state/output relevant to this canary.

        Returns:
            A float representing the drift magnitude. Higher values indicate more drift.
        """
        pass

    @abc.abstractmethod
    def is_degraded(self, drift_magnitude: float) -> bool:
        """
        Determines if the measured drift indicates degradation.

        Args:
            drift_magnitude: The output from `measure_drift`.

        Returns:
            True if degradation is detected, False otherwise.
        """
        pass

    @abc.abstractmethod
    def get_degradation_details(self, drift_magnitude: float) -> Optional[str]:
        """
        Provides human-readable details about the detected degradation.

        Args:
            drift_magnitude: The output from `measure_drift`.

        Returns:
            A string with degradation details, or None if no degradation.
        """
        pass


class TextDegenerationCanary(DriftAxisCanary):
    """
    A concrete canary that monitors text degeneration (e.g., repetition, coherence loss).
    This is a placeholder/stub implementation.
    """

    def __init__(self, threshold: float = 0.5):
        self.threshold = threshold

    def measure_drift(self, current_text: str, baseline_text: str) -> float:
        # Placeholder: In a real implementation, this would use NLP metrics.
        # For now, let's just return a dummy value based on text length difference.
        len_diff = abs(len(current_text) - len(baseline_text))
        return float(len_diff) / max(len(current_text), len(baseline_text), 1)

    def is_degraded(self, drift_magnitude: float) -> bool:
        return drift_magnitude > self.threshold

    def get_degradation_details(self, drift_magnitude: float) -> Optional[str]:
        if self.is_degraded(drift_magnitude):
            return f"Text degeneration detected. Drift magnitude: {drift_magnitude:.2f} (threshold: {self.threshold})"
        return None


class GroundednessCanary(DriftAxisCanary):
    """
    A stub for a canary that monitors the groundedness of agent responses.
    """

    def __init__(self, threshold: float = 0.2):
        self.threshold = threshold

    def measure_drift(self, current_response: Any, baseline_response: Any) -> float:
        # Placeholder: In a real implementation, this would compare response to source.
        return 0.0  # Always 0 for now

    def is_degraded(self, drift_magnitude: float) -> bool:
        return drift_magnitude > self.threshold

    def get_degradation_details(self, drift_magnitude: float) -> Optional[str]:
        if self.is_degraded(drift_magnitude):
            return f"Groundedness degradation detected. Drift magnitude: {drift_magnitude:.2f} (threshold: {self.threshold})"
        return None


class AgentDriftMonitor:
    """
    A generalized monitor for detecting drift in agent behavior using pluggable canaries.
    """

    def __init__(self, canaries: List[DriftAxisCanary]):
        self.canaries = canaries

    def monitor(self, current_agent_state: Any, baseline_agent_state: Any) -> Dict[str, Any]:
        results = {}
        for i, canary in enumerate(self.canaries):
            drift_magnitude = canary.measure_drift(current_agent_state, baseline_agent_state)
            is_degraded = canary.is_degraded(drift_magnitude)
            details = canary.get_degradation_details(drift_magnitude)

            results[f"canary_{i}_{type(canary).__name__}"] = {
                "drift_magnitude": drift_magnitude,
                "is_degraded": is_degraded,
                "details": details,
            }
        return results
