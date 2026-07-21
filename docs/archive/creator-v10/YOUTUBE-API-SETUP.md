# YouTube Data API v3 Setup Guide

**Project:** steel-archery-499601-a6  
**Console:** https://console.cloud.google.com/apis/api/youtube.googleapis.com/metrics?project=steel-archery-499601-a6

---

## 1. Enable the YouTube Data API v3

### In Google Cloud Console:

1. Go to: https://console.cloud.google.com/apis/library?project=steel-archery-499601-a6
2. Search for **"YouTube Data API v3"**
3. Click the result
4. Click **ENABLE**

(Should show "API is enabled" on the metrics page you linked)

---

## 2. Create API Key

### Steps:

1. Go to **Credentials** in your project:
   https://console.cloud.google.com/apis/credentials?project=steel-archery-499601-a6

2. Click **+ CREATE CREDENTIALS** → **API Key**

3. Copy the generated key (looks like: `AIza...`)

4. **IMPORTANT:** Restrict the key to YouTube API only:
   - Click on your new key
   - Under **API restrictions**, select **YouTube Data API v3**
   - Save

---

## 3. Set Environment Variable (Local)

### Windows PowerShell:

```powershell
$env:YOUTUBE_API_KEY = "AIza..."
```

Or add to your `.env` file:

```
YOUTUBE_API_KEY=AIza...
```

### Verify:

```powershell
echo $env:YOUTUBE_API_KEY
```

---

## 4. Quota & Limits

### Default YouTube API Quotas:

| Metric | Quota |
|--------|-------|
| **Queries per day** | 10,000 |
| **Requests per second** | ~1-2 (with backoff) |
| **Search results per query** | 50 results |

### Your Usage:

For collecting 5,000 Shorts:
- `search.list()` = ~100 queries (50 results × 100 = 5,000)
- **Cost:** 100 quota units per query = **10,000 quota units/day**
- **Frequency:** Once per 6h retraining = 4× per day = 40,000 quota/day

⚠️ **You'll hit the 10,000 limit quickly.** Options:

1. **Request quota increase** (Google form, takes 24-48h)
2. **Collect once, reuse** (recommended for MVP)
3. **Rotate search queries** (spread load)

---

## 5. Enable in Collector Script

### Edit: `scripts/youtube_shorts_collector_v2.py`

**Uncomment the production API code (lines 70-85):**

```python
# Around line 70, replace this:
logger.warning("YouTube API key required. Set up googleapiclient.discovery for live ingestion.")
return []

# With this:
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

youtube = build('youtube', 'v3', developerKey=self.api_key)

results = []
for query in self.search_queries:
    try:
        request = youtube.search().list(
            q=query,
            part='snippet',
            type='video',
            videoDuration='short',  # Shorts only
            order='viewCount',
            maxResults=50,
            publishedAfter=(datetime.utcnow() - timedelta(days=30)).isoformat() + 'Z',
            regionCode='US'
        )
        
        while request and len(results) < max_results:
            response = request.execute()
            for item in response.get('items', []):
                snippet = item.get('snippet', {})
                video_id = item.get('id', {}).get('videoId', '')
                
                # Get detailed stats
                stats_request = youtube.videos().list(
                    part='statistics,contentDetails',
                    id=video_id
                )
                stats_response = stats_request.execute()
                stats = stats_response['items'][0]['statistics'] if stats_response['items'] else {}
                
                record = {
                    'video_id': video_id,
                    'title': snippet.get('title', ''),
                    'channel_id': snippet.get('channelId', ''),
                    'channel_name': snippet.get('channelTitle', ''),
                    'publish_date': snippet.get('publishedAt', ''),
                    'duration': self._parse_duration(stats_response['items'][0].get('contentDetails', {}).get('duration', '')),
                    'views': int(stats.get('viewCount', 0)),
                    'likes': int(stats.get('likeCount', 0)),
                    'comments': int(stats.get('commentCount', 0)),
                    'tags': snippet.get('tags', []),
                    'category_id': snippet.get('categoryId', ''),
                    'description': snippet.get('description', ''),
                    'query_source': query,
                    'timestamp': datetime.utcnow().isoformat(),
                }
                results.append(record)
                
                if len(results) >= max_results:
                    break
            
            # Get next page
            request = youtube.search_list_next(request, response) if len(results) < max_results else None
            time.sleep(1)  # Rate limiting
            
    except HttpError as e:
        logger.error(f"Query '{query}' failed: {e}")
        time.sleep(5)  # Back off on error
        continue

return results
```

Also add helper method to `YouTubeShortsCollectorV2`:

```python
def _parse_duration(self, duration_str: str) -> int:
    """Parse ISO 8601 duration (PT27S -> 27)"""
    import re
    match = re.search(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', duration_str)
    if match:
        hours = int(match.group(1) or 0)
        minutes = int(match.group(2) or 0)
        seconds = int(match.group(3) or 0)
        return hours * 3600 + minutes * 60 + seconds
    return 0
```

---

## 6. Install Dependencies

```bash
pip install google-auth-oauthlib google-auth-httplib2 google-api-python-client
```

---

## 7. Test Connection

```bash
export YOUTUBE_API_KEY="AIza..."
python -c "
from googleapiclient.discovery import build
import os

api_key = os.getenv('YOUTUBE_API_KEY')
youtube = build('youtube', 'v3', developerKey=api_key)

# Test search
request = youtube.search().list(
    q='minecraft shorts',
    part='snippet',
    type='video',
    videoDuration='short',
    maxResults=1
)
response = request.execute()
print(f'✅ Connected! Found {len(response.get(\"items\", []))} videos')
"
```

---

## 8. Rate Limiting Strategy

### For 5,000 Shorts Collection:

```python
# In collector, add backoff:
import time

def collect_with_backoff(self, max_results=5000):
    results = []
    for query in self.search_queries:
        try:
            request = youtube.search().list(...)
            response = request.execute()
            results.extend(...)
            time.sleep(1)  # 1s between queries
        except HttpError as e:
            if e.resp.status == 429:  # Rate limited
                logger.warning('Rate limited, sleeping 60s')
                time.sleep(60)
                continue
    return results
```

---

## 9. Run Collection

### First Time (with real API):

```bash
export YOUTUBE_API_KEY="AIza..."

python scripts/youtube_shorts_collector_v2.py \
  --api-key $YOUTUBE_API_KEY \
  --limit 5000 \
  --use-mock false

# Monitor progress
tail -f data/youtube/raw_shorts_dataset.jsonl
```

### Then Continue Pipeline:

```bash
python scripts/filter_gaming_shorts.py
python lib/v10_feature_extractor.py
python models/train_xgboost_v10.py

# Check results
cat models/training_report.json | jq '.feature_importance'
```

---

## 10. Quota Monitoring

### Check Your Usage:

https://console.cloud.google.com/apis/api/youtube.googleapis.com/metrics?project=steel-archery-499601-a6

Look for:
- **YouTube API v3 Requests** (should show your API calls)
- **Quota usage** (% of 10,000/day used)

### Request Quota Increase:

If you need more than 10,000 quota/day:

1. Go to **Quotas** in your project
2. Select **YouTube Data API v3**
3. Click **Edit Quotas**
4. Request higher daily limit (Google reviews manually)

Typical approval: 24-48 hours

---

## 11. Continuous Collection Setup

### Option A: Run Every 6 Hours (Recommended for MVP)

```bash
# Start daemon
python scripts/v10_training_loop.py --interval 6 &

# In v10_training_loop.py, it will:
# 1. Collect 5000 shorts (uses 10k quota)
# 2. Filter gaming
# 3. Extract features
# 4. Retrain model
# 5. Sleep 6 hours
# 6. Repeat
```

### Option B: Collect Once, Reuse

```bash
# One-time collection
python scripts/youtube_shorts_collector_v2.py --api-key $YOUTUBE_API_KEY --limit 5000

# Then just retrain model (no API calls needed)
python scripts/v10_training_loop.py --interval 24 --skip-collection true
```

Recommended for staying within quota.

---

## 12. Troubleshooting

### "Invalid API Key"

```bash
# Verify key is set
echo $env:YOUTUBE_API_KEY

# Check it's valid
curl "https://www.googleapis.com/youtube/v3/search?key=$env:YOUTUBE_API_KEY&q=test&part=snippet&maxResults=1"
# Should return JSON, not error
```

### "Rate Limited (429)"

Script automatically backs off 60s. If persistent:
- Reduce `maxResults` per query
- Increase sleep between queries
- Request quota increase from Google

### "Quota Exceeded"

You've hit 10,000/day limit.

Options:
1. Wait until tomorrow (quota resets at midnight UTC)
2. Request increase from Google
3. Collect once, reuse for next 30 days

---

## Summary

| Step | Status | Command |
|------|--------|---------|
| Enable API | ✅ Click button in console | — |
| Create key | ✅ Generate in Credentials | — |
| Install libs | ✅ `pip install google-*` | — |
| Uncomment code | 🔶 Edit collector_v2.py | See §5 |
| Set env var | ✅ `export YOUTUBE_API_KEY=...` | — |
| Test connection | ✅ Run test script in §7 | — |
| Collect data | ✅ `python youtube_shorts_collector_v2.py` | — |
| Train model | ✅ `python models/train_xgboost_v10.py` | — |
| Start daemon | ✅ `python scripts/v10_training_loop.py` | — |

**You're ready to go live.** 🚀
