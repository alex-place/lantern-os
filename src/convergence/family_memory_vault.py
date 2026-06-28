from typing import Dict, Any, List, Optional
from convergence.memory import get_memory_store
from convergence.objects import Memory

class FamilyMemoryVault:
    """
    A vault for storing and managing shared family memories.

    This class provides an interface to add, retrieve, update, and delete
    Memory objects specifically designated as 'family_memory_vault' items
    within the Convergence Memory Store. Each memory's content includes
    'type', 'owner', and 'data' fields for categorization and multi
