# User Profiles — Local-First Backend

Lantern OS includes a **local-only, OSS-style user profile system** using CSF (Convergence-Fitted Searchable Format) for persistent storage. All user data stays local with no cloud dependency.

## Features

- **Local-only storage** — All profiles stored in `data/profiles/` as JSONL + CSF archives
- **Automatic Patreon sync** — User profiles auto-created from Patreon OAuth
- **Role configuration** — Admins can override roles independent of Patreon tiers
- **Custom profiles** — Support for local-only users without Patreon
- **JSONL audit log** — Append-only log of all profile changes (immutable history)
- **CSF archives** — Binary-friendly format for export/import
- **In-memory cache** — Fast reads with automatic invalidation on writes

## Architecture

### Data Flow

```
Patreon OAuth
     ↓
getOrCreateFromPatreon()
     ↓
User Profile (local database)
     ↓
Session + JSONL log + CSF archive
```

### Files

| File | Purpose |
|------|---------|
| `lib/user-profiles.js` | Core profile system: CRUD, role management, CSF export/import |
| `routes/profiles.js` | REST API endpoints for profile management |
| `data/profiles/index.jsonl` | Append-only log of all profile records |
| `data/profiles/profiles.csf` | Binary CSF archive backup (for export) |

## API Endpoints

### User Endpoints (Authenticated)

#### `GET /api/profiles/me`
Get current user's full profile.

**Response:**
```json
{
  "id": "49294581",
  "name": "John Doe",
  "email": "john@example.com",
  "role": "supporter",
  "tier": "28764312",
  "patreonId": "49294581",
  "avatar": null,
  "bio": "Love Lantern OS!",
  "settings": {},
  "preferences": {
    "theme": "dark",
    "notifications": true,
    "emailNotifications": false
  },
  "metadata": {
    "createdAt": "2026-06-17T20:30:00Z",
    "updatedAt": "2026-06-17T20:30:00Z",
    "lastLoginAt": "2026-06-17T20:35:00Z",
    "source": "patreon"
  }
}
```

#### `PUT /api/profiles/me`
Update current user's profile (name, bio, preferences only).

**Request:**
```json
{
  "name": "Jane Doe",
  "bio": "New bio",
  "preferences": {
    "theme": "light",
    "notifications": false
  }
}
```

Users **cannot** change their own role or tier via this endpoint.

### Admin Endpoints

#### `GET /api/profiles`
List all profiles (admin-only).

**Query parameters:**
- `role` — Filter by role (guest, supporter, founder, admin)
- `search` — Search by name, email, or ID

**Response:**
```json
{
  "profiles": [...],
  "count": 42
}
```

#### `GET /api/profiles/:userId`
Get any user's profile (admin-only).

#### `PUT /api/profiles/:userId/role`
Set a user's role (admin-only).

**Request:**
```json
{
  "role": "founder"
}
```

Valid roles: `guest`, `supporter`, `founder`, `admin`

#### `DELETE /api/profiles/:userId`
Soft-delete a profile (mark as deleted, admin-only).

#### `GET /api/profiles/export/csf`
Export all profiles to CSF archive (admin-only).

**Response:**
```json
{
  "format": "CSF-1.0",
  "type": "user-profiles",
  "timestamp": "2026-06-17T20:30:00Z",
  "version": 1,
  "records": [...],
  "metadata": {
    "totalProfiles": 42,
    "roleDistribution": {
      "guest": 10,
      "supporter": 25,
      "founder": 5,
      "admin": 2
    }
  }
}
```

## Usage

### Create a Profile Programmatically

```javascript
const { createProfile } = require('./lib/user-profiles');

const profile = createProfile('user-123', {
  name: 'John Doe',
  email: 'john@example.com',
  role: 'supporter',
  source: 'local',
});
```

### Get or Create from Patreon

```javascript
const { getOrCreateFromPatreon } = require('./lib/user-profiles');

const patreonUser = {
  id: '49294581',
  name: 'John Doe',
  email: 'john@example.com',
  primaryTier: '28764312',
};

const profile = getOrCreateFromPatreon(patreonUser, 'supporter');
```

### Override a User's Role

```javascript
const { setUserRole } = require('./lib/user-profiles');

// Admin changes a user's role
const profile = setUserRole('user-123', 'founder');
```

### List All Users by Role

```javascript
const { listProfiles } = require('./lib/user-profiles');

const admins = listProfiles({ role: 'admin' });
const supporters = listProfiles({ role: 'supporter' });
```

### Export Profiles

```javascript
const { exportToCSF } = require('./lib/user-profiles');

const csf = exportToCSF();
// Saved to data/profiles/profiles.csf
```

## Data Storage

### JSONL Format

`data/profiles/index.jsonl` — Append-only log of all profile changes:

```jsonl
{"id":"user-1","name":"Alice","role":"admin",...}
{"id":"user-2","name":"Bob","role":"supporter",...}
{"id":"user-1","name":"Alice","role":"founder",...}
```

Each line is a complete profile record. **Latest version wins** — when loading a profile, the system reads the entire file and returns the last occurrence of that user ID.

**Why append-only?**
- Immutable audit trail
- Simple crash recovery
- No partial writes
- Easy to stream/process
- Perfect for CSF archival

### CSF Format

`data/profiles/profiles.csf` — Binary-friendly archive backup:

```json
{
  "format": "CSF-1.0",
  "type": "user-profiles",
  "timestamp": "2026-06-17T20:30:00Z",
  "records": [...]
}
```

Generated by `exportToCSF()`. Can be imported with `importFromCSF()`.

## Role System

### Built-in Roles

| Role | Source | Use Case |
|------|--------|----------|
| `guest` | Patreon (non-member) or local | View-only access |
| `supporter` | legacy $5 patrons — **retired** Member tier | Free-plan floor; **no longer sold** |
| `deep_dreamer` | Patreon $20 (**Pro**) | All Pro features + real-money trading |
| `founder` | legacy alias for `deep_dreamer` (#698) | same as Pro |
| `pilot` | Patreon $200 (**Pilot**) | Everything in Pro + autonomous AI trader |
| `admin` | Manual assignment (`LANTERN_ADMIN_IDS`) | System administration |

### Custom Roles

You can add custom roles beyond the built-in set:

```javascript
const profile = updateProfile('user-123', { role: 'moderator' });
```

The role system is **flexible** — any string is valid. Use role-based access control in your frontend/backend to enforce permissions.

## Session Integration

When a user logs in via Patreon OAuth:

1. **Token exchange** → Get Patreon identity
2. **Profile lookup** → `getOrCreateFromPatreon()`
3. **Session creation** → `setSessionUser(req, ...)` writes the provider-agnostic
   `req.session.user` shape (the legacy `req.session.patreon` mirror was removed — ADR-0016 #1947)
4. **JSONL append** → Log the profile creation/update
5. **Cache update** → In-memory cache for fast lookups

Every provider (patreon / google / discord / local) writes the same `req.session.user`, and the **source of truth is the profile database**.

## Offline Mode

Profiles work **completely offline** — no cloud calls, no external dependencies:

- No API keys required
- No authentication to third-party services
- All data stored locally in `data/profiles/`
- Works without internet connection (except Patreon OAuth, which requires Patreon)

## Backup & Restore

### Backup

```bash
# Export all profiles to CSF
curl -H "Authorization: Bearer admin-token" \
  http://127.0.0.1:4177/api/profiles/export/csf > profiles-backup.json
```

### Restore

```javascript
const fs = require('fs');
const { importFromCSF } = require('./lib/user-profiles');

const backup = JSON.parse(fs.readFileSync('profiles-backup.json'));
const imported = importFromCSF(backup);
console.log(`Restored ${imported} profiles`);
```

## Performance

### In-Memory Cache

Profiles are cached in memory on first read. Cache invalidates on write:

```javascript
getProfile('user-123'); // JSONL read + cache
getProfile('user-123'); // Cache hit (instant)
updateProfile('user-123', { name: 'New Name' }); // Cache invalidated
getProfile('user-123'); // JSONL read + cache refresh
```

### Large User Bases

For **large deployments** (10k+ users):

1. **Separate JSONL files** — Split by user ID range or date
2. **Index database** — Add SQLite for fast queries
3. **Sharding** — Distribute profiles across nodes
4. **CSF compression** — Binary format for smaller archives

Current implementation is optimized for **local single-instance deployments** (< 10k users).

## Admin Dashboard (Future)

Profile data feeds into:
- User management UI
- Role administration
- Audit logs
- Export/import tools
- Analytics

## Security Considerations

1. **No credentials stored** — Passwords never saved (Patreon OAuth only)
2. **HTTP-only sessions** — Cannot be accessed by JavaScript
3. **Role enforcement** — Check role on every admin API call
4. **Audit trail** — JSONL log is immutable record of all changes
5. **Local storage** — No data leaves the machine (offline-capable)

## FAQ

**Q: Can I delete a profile permanently?**
A: `DELETE /api/profiles/:userId` soft-deletes (marks as deleted). The JSONL record remains for audit purposes. For hard delete, manually edit `data/profiles/index.jsonl`.

**Q: What if two changes happen simultaneously?**
A: JSONL append is atomic. Race conditions are handled by reading the entire file and using the last record per user.

**Q: Can I sync profiles to an external database?**
A: Yes, use `exportToCSF()` to export, then sync the JSON to your external store. Keep local copy as source of truth.

**Q: What if I restart the server?**
A: Sessions are cleared (in-memory store), but profiles persist in JSONL. Users log back in via Patreon OAuth, profile is reloaded.

## Next Steps

- [ ] Implement profile avatar/image storage
- [ ] Add email verification
- [ ] Build admin dashboard UI
- [ ] Add profile search/filtering UI
- [ ] Implement profile export to vCard format
- [ ] Add profile webhooks for integrations
