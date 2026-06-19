# Lantern OS Repository Cleanup Plan

**Date:** 2026-06-13  
**Purpose:** Identify and archive unused/old code before hard deletion  
**Scope:** Directories >100KB, test artifacts, legacy systems

---

## 📊 Directory Size Analysis

| Directory | Size | Files | Status | Recommendation |
|-----------|------|-------|--------|-----------------|
| **models/** | 5.2G | 32 | ACTIVE | Archive to cloud/external storage |
| **data/** | 909M | N/A | ACTIVE | Keep (dream journal, conversations) |
| **apps/** | 158M | N/A | ACTIVE | Keep (lantern-garage, primary app) |
| **src/** | 37M | N/A | ACTIVE | Keep (Python services, MCP server) |
| **archive/** | 964K | 1 | REDUNDANT | Hard delete (old archives) |
| **training_data/** | 284K | 4 | INACTIVE | Archive to D:\tmp |
| **rag/** | 276K | 15 | INACTIVE | Archive to D:\tmp |
| **logs/** | 272K | 2 | TEMP | Hard delete (runtime logs) |
| **test-results/** | 85K | 8 | TEMP | Hard delete (test artifacts) |
| **merge-patches/** | 80K | 1 | INACTIVE | Archive to D:\tmp |
| **patches/** | 16K | 3 | INACTIVE | Archive to D:\tmp |
| **.tmp.driveupload/** | 26.6GB | N/A | TEMP | Hard delete (temp cache) |
| **.tmp.drivedownload/** | 0B | 0 | TEMP | Hard delete (empty) |
| **.pytest_cache/** | N/A | N/A | TEMP | Hard delete |
| **__pycache__/** | N/A | N/A | TEMP | Hard delete |
| **.github-cache/** | N/A | N/A | TEMP | Hard delete |

---

## 🎯 Cleanup Tiers

### TIER 1: SAFE TO DELETE NOW (No code dependency)
These are artifacts with no active references in code.

```
.tmp.drivedownload/        # Empty temp dir
.tmp.driveupload/          # Google Drive temp cache (26.6GB)
logs/                       # Runtime logs (272K)
test-results/               # Test artifacts (85K)
.pytest_cache/              # Python cache
__pycache__/                # Python bytecode
.github-cache/              # GitHub API cache
templates/                  # Empty (4K)
benchmarks/                 # Empty (4K)
profiles/                   # Empty (4K)
repo-seeds/                 # Empty (0B)
LANTERNOS/                  # Empty (0B)
screenshots/                # Old screenshots (4K)
```

**Delete Command:**
```bash
rm -rf .tmp.drivedownload .tmp.driveupload logs test-results
rm -rf .pytest_cache __pycache__ .github-cache
rm -rf templates benchmarks profiles repo-seeds LANTERNOS screenshots
```

**Space Saved:** ~26.7GB

---

### TIER 2: ARCHIVE TO D:\tmp BEFORE DELETING
These have historical value but aren't actively used.

```
training_data/              # LoRA/ML training datasets (284K)
rag/                        # RAG documents (276K)
merge-patches/              # Old merge patches (80K)
patches/                    # Old patch files (16K)
archive/                    # Redundant archives (964K)
```

**Archive Steps:**
```bash
# 1. Create archive in D:\tmp
mkdir -p "D:\tmp\lantern-os-deleted-2026-06-13"
cp -r training_data "D:\tmp\lantern-os-deleted-2026-06-13/"
cp -r rag "D:\tmp\lantern-os-deleted-2026-06-13/"
cp -r merge-patches "D:\tmp\lantern-os-deleted-2026-06-13/"
cp -r patches "D:\tmp\lantern-os-deleted-2026-06-13/"
cp -r archive "D:\tmp\lantern-os-deleted-2026-06-13/"

# 2. Verify archive
du -sh "D:\tmp\lantern-os-deleted-2026-06-13"

# 3. Delete from repo
rm -rf training_data rag merge-patches patches archive
```

**Space Saved:** ~1.6MB  
**Archive Location:** `D:\tmp\lantern-os-deleted-2026-06-13/`

---

### TIER 3: REVIEW & DECIDE (Need assessment)

#### **models/** (5.2G)
- **Status:** Actively used by `generate_door_lora.py` and image generation
- **Dependencies:**
  - `src/generate_door_lora.py` — references `models/csf-image/`
  - `src/training/generate_training_dataset.py` — references model files
- **Recommendation:** Move to cloud storage (AWS S3, HuggingFace) with download-on-demand
- **Action:** 
  - [ ] Set up cloud model registry
  - [ ] Update code to download models on first run
  - [ ] Archive to D:\tmp as backup
  - [ ] Remove from repo after verification

#### **integrations/hff/** 
- Check if integrations are actively used
- If not, can be archived

#### **lore/** (83K)
- Story/lore documents
- Check if needed for creative context

#### **content/** (12K)
- Static content files
- Check if still referenced

---

## 📋 Pre-Deletion Checklist

### Code Audit
- [ ] Grep all references to `models/`, `training_data/`, `rag/`
- [ ] Verify image generation works with archived models
- [ ] Check git history for recent changes

### Data Preservation
- [ ] Backup to Google Drive: `Lantern OS/Archives/deleted-2026-06-13/`
- [ ] Backup to D:\tmp: `D:\tmp\lantern-os-deleted-2026-06-13/`

### Git Cleanup
- [ ] After deletion, run: `git gc --aggressive`
- [ ] Check repo size: `du -sh .git`

### Documentation
- [ ] Update CLEANUP-PLAN.md with completion timestamp
- [ ] Document what was deleted and why

---

## 🚀 Execution Order

### Step 1: Safe Deletions (No Risk)
```bash
git checkout master
git pull origin master
rm -rf .tmp.drivedownload .tmp.driveupload logs test-results
rm -rf .pytest_cache __pycache__ .github-cache
rm -rf templates benchmarks profiles repo-seeds LANTERNOS screenshots
git add -A && git commit -m "chore: Clean up temp files and caches"
```

### Step 2: Archive Then Delete
```bash
# Archive
mkdir -p "D:\tmp\lantern-os-deleted-2026-06-13"
for dir in training_data rag merge-patches patches archive; do
  cp -r "$dir" "D:\tmp\lantern-os-deleted-2026-06-13/"
done

# Delete
rm -rf training_data rag merge-patches patches archive
git add -A && git commit -m "chore: Archive and remove legacy data directories"
```

### Step 3: Models Review & Decision
- [ ] Evaluate cloud storage setup
- [ ] Make decision on models/

### Step 4: Post-Cleanup
```bash
git gc --aggressive
du -sh . .git
```

---

## 📊 Expected Results

**Before Cleanup:**
- Repo size: ~7.2GB (estimated)
- Largest dir: models/ (5.2GB)

**After Tier 1+2:**
- Repo size: ~7.1GB (after Tier 1+2)
- Space freed: ~26.7GB (temp) + ~1.6MB (archives) = **26.7GB**

**After Tier 3 (models):**
- Repo size: ~1.9GB
- Space freed: **~5.2GB additional**

---

## ⚠️ Rollback Plan

If deletion causes issues:
```bash
# Restore from Google Drive
# Or restore individual files from archived folder:
cp -r "D:\tmp\lantern-os-deleted-2026-06-13/training_data" training_data
```

---

## 🔗 Related Issues
- #364: PR #354 merge tracking
- #365: PR #363 merge tracking  
- #367: PR #355 scope decision
- #368: PR merge coordination

---

**Status:** READY FOR EXECUTION  
**Last Updated:** 2026-06-13  
**Next Review:** After Tier 1 deletion (estimate: 1 day)
